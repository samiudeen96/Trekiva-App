import { Prisma, type Campaign, type PrismaClient, type WelcomeClaim } from "@prisma/client";
import { isValidEmail, normalizeEmail } from "./email-address";
import { generateUniqueCode } from "./discount-code";
import type { Mailer } from "./email/mailer.server";
import type { EmailVars } from "./email/template";
import { DiscountCodeTakenError } from "./shopify-errors";
import type { ShopifyGateway } from "./shopify-gateway.server";
import { bumpStat } from "./stats.server";

export const MAX_ATTEMPTS = 5;
/** A PENDING claim older than this is assumed to be a crashed request and may be resumed. */
export const STALE_PENDING_MS = 2 * 60_000;

export type ClaimDeps = {
  db: PrismaClient;
  gateway: ShopifyGateway;
  mailer: Mailer;
  now?: () => Date;
};

export type ClaimOutcome = {
  httpStatus: number;
  body: { status: string; message: string };
};

const outcome = (httpStatus: number, status: string, message: string): ClaimOutcome => ({
  httpStatus,
  body: { status, message },
});

function isUniqueViolation(err: unknown) {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export function formatDiscountValue(c: Pick<Campaign, "discountType" | "discountValue">) {
  const n = Number(c.discountValue);
  const str = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return c.discountType === "PERCENTAGE" ? `${str}%` : str;
}

/**
 * The claim flow. Order matters:
 *   1. validate -> 2. campaign lookup -> 3. atomic INSERT (unique constraint is the lock)
 *   -> 4. Shopify customer -> 5. discount -> 6. email -> 7. mark SENT.
 * Whoever wins the INSERT owns the claim; everyone else gets `already_claimed`.
 * The discount code is never part of the returned body.
 */
export async function processClaim(
  deps: ClaimDeps,
  input: { shop: string; campaignId: string; email: string },
): Promise<ClaimOutcome> {
  const { db } = deps;
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) {
    return outcome(400, "invalid_email", "Please enter a valid email address.");
  }

  const campaign = await db.campaign.findFirst({
    where: { id: input.campaignId, shop: input.shop },
  });
  if (!campaign || !campaign.active) {
    return outcome(404, "campaign_unavailable", "This offer is no longer available.");
  }

  await bumpStat(db, campaign.shop, campaign.id, "SUBMISSION");

  const claimKey = { shop: campaign.shop, campaignId: campaign.id, email };
  let claim: WelcomeClaim;
  try {
    claim = await db.welcomeClaim.create({ data: { ...claimKey, status: "PENDING" } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;

    // Already exists. Only a claim that never completed (provider/Shopify failure, or a
    // crashed request) may be resumed — and resuming is itself an atomic compare-and-set,
    // so two concurrent retries cannot both win.
    const staleBefore = new Date((deps.now?.() ?? new Date()).getTime() - STALE_PENDING_MS);
    const took = await db.welcomeClaim.updateMany({
      where: {
        ...claimKey,
        attemptCount: { lt: MAX_ATTEMPTS },
        OR: [
          { status: { in: ["EMAIL_FAILED", "FAILED"] } },
          { status: "PENDING", updatedAt: { lt: staleBefore } },
        ],
      },
      data: { status: "PENDING", attemptCount: { increment: 1 } },
    });
    if (took.count === 0) {
      const existing = await db.welcomeClaim.findFirst({ where: claimKey, select: { status: true } });
      await bumpStat(db, campaign.shop, campaign.id, "DUPLICATE");
      if (existing?.status === "INELIGIBLE") {
        return outcome(200, "not_eligible", campaign.notEligibleMessage);
      }
      return outcome(200, "already_claimed", campaign.alreadyClaimedMessage);
    }
    claim = await db.welcomeClaim.findFirstOrThrow({ where: claimKey });
  }

  return fulfil(deps, campaign, claim);
}

async function fulfil(deps: ClaimDeps, campaign: Campaign, claim: WelcomeClaim): Promise<ClaimOutcome> {
  const { db, gateway, mailer } = deps;
  const shop = campaign.shop;
  const fail = async (status: "FAILED" | "EMAIL_FAILED", err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[claim ${claim.id}] ${status}:`, message);
    await db.welcomeClaim.update({
      where: { id: claim.id },
      data: { status, lastError: message.slice(0, 500) },
    });
    if (status === "EMAIL_FAILED") await bumpStat(db, shop, campaign.id, "EMAIL_FAILED");
    return outcome(
      status === "EMAIL_FAILED" ? 502 : 500,
      "error",
      status === "EMAIL_FAILED"
        ? "We couldn't send your email just now. Please try again in a few minutes."
        : campaign.errorMessage,
    );
  };

  let customerId = claim.shopifyCustomerId;
  let discountCode = claim.discountCode;

  try {
    // --- Shopify customer (lookup / create / eligibility / tag) -----------------------
    const needsCustomer =
      campaign.createCustomer || campaign.firstOrderOnly || campaign.discountMode === "UNIQUE";
    if (needsCustomer && !customerId) {
      const existing = await gateway.findCustomerByEmail(shop, claim.email);
      let tagged = false; // a freshly created customer is created with the tag already
      if (existing) {
        if (campaign.firstOrderOnly && existing.ordersCount > 0) {
          await db.welcomeClaim.update({
            where: { id: claim.id },
            data: { status: "INELIGIBLE", shopifyCustomerId: existing.id },
          });
          return outcome(200, "not_eligible", campaign.notEligibleMessage);
        }
        customerId = existing.id;
      } else if (campaign.createCustomer || campaign.discountMode === "UNIQUE") {
        const tags = campaign.tagCustomer && campaign.customerTag ? [campaign.customerTag] : [];
        customerId = (await gateway.createCustomer(shop, claim.email, tags)).id;
        tagged = true;
      }
      if (customerId) {
        await db.welcomeClaim.update({ where: { id: claim.id }, data: { shopifyCustomerId: customerId } });
        if (!tagged && campaign.tagCustomer && campaign.customerTag) {
          await gateway.addCustomerTag(shop, customerId, campaign.customerTag).catch((e) => {
            console.warn(`[claim ${claim.id}] tagging failed (non-fatal):`, e.message); // idempotent; harmless
          });
        }
      }
    }

    // --- Discount code (reused on resume so a retry never creates a second code) -------
    if (!discountCode) {
      if (campaign.discountMode === "SHARED") {
        if (!campaign.sharedCode) throw new Error("Campaign has no shared discount code configured");
        discountCode = campaign.sharedCode;
        await db.welcomeClaim.update({ where: { id: claim.id }, data: { discountCode } });
      } else {
        let created: { discountId: string; code: string } | null = null;
        for (let i = 0; i < 4 && !created; i++) {
          const code = generateUniqueCode(campaign.codePrefix);
          try {
            created = await gateway.createUniqueDiscount(shop, { campaign, code, customerId });
          } catch (e) {
            if (!(e instanceof DiscountCodeTakenError)) throw e;
          }
        }
        if (!created) throw new Error("Could not generate a unique discount code");
        discountCode = created.code;
        await db.welcomeClaim.update({
          where: { id: claim.id },
          data: { discountCode, shopifyDiscountId: created.discountId },
        });
      }
    }
  } catch (err) {
    return fail("FAILED", err);
  }

  // --- Email --------------------------------------------------------------------------
  try {
    const shopInfo = await gateway.getShopInfo(shop);
    const vars: EmailVars = {
      discount_code: discountCode!,
      discount_value: formatDiscountValue(campaign),
      shop_url: shopInfo.url,
      shop_name: shopInfo.name,
    };
    await mailer.sendDiscountEmail({ to: claim.email, campaign, vars });
  } catch (err) {
    return fail("EMAIL_FAILED", err);
  }

  await db.welcomeClaim.update({
    where: { id: claim.id },
    data: { status: "SENT", emailSentAt: (deps.now?.() ?? new Date()), lastError: null },
  });
  await bumpStat(db, shop, campaign.id, "CLAIM");
  await bumpStat(db, shop, campaign.id, "EMAIL_SENT");
  return outcome(200, "success", campaign.successMessage);
}

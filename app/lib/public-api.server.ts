import { z } from "zod";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { checkToken, issueToken } from "./bot-token.server";
import { normalizeEmail } from "./email-address";
import { processClaim } from "./claims.server";
import { createMailer } from "./email/mailer.server";
import { clientIp, corsHeaders, isShopDomain, json } from "./public-http.server";
import { rateLimit } from "./rate-limit.server";
import { createShopifyGateway } from "./shopify-gateway.server";
import { bumpStat } from "./stats.server";

const MAX_BODY_BYTES = 4_096;

/**
 * Shop resolution for public endpoints. Two entry paths:
 *  - Shopify App Proxy (default, same-origin from the storefront): the request carries
 *    Shopify's HMAC `signature`, which we verify; the shop comes from the signed query.
 *  - Direct call (POST /api/public/welcome-claim): shop comes from the request and must be
 *    a *.myshopify.com domain of an installed shop.
 */
async function resolveShop(request: Request, claimedShop: unknown): Promise<string | Response> {
  const url = new URL(request.url);
  if (url.searchParams.has("signature")) {
    try {
      await authenticate.public.appProxy(request); // throws a Response on a bad signature
    } catch {
      return json(request, { status: "forbidden", message: "Invalid request signature." }, 403);
    }
    const shop = url.searchParams.get("shop");
    if (!isShopDomain(shop) || (claimedShop && claimedShop !== shop)) {
      return json(request, { status: "invalid_request", message: "Invalid shop." }, 400);
    }
    return shop;
  }
  if (!isShopDomain(claimedShop)) {
    return json(request, { status: "invalid_request", message: "Invalid shop." }, 400);
  }
  const installed = await db.session.findFirst({
    where: { shop: claimedShop, isOnline: false },
    select: { id: true },
  });
  if (!installed) {
    return json(request, { status: "invalid_request", message: "Unknown shop." }, 404);
  }
  return claimedShop;
}

async function readJson(request: Request): Promise<unknown | null> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > MAX_BODY_BYTES) return null;
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const claimSchema = z.object({
  shop: z.string().max(100).optional(),
  campaignId: z.string().min(1).max(40),
  email: z.string().max(254),
  token: z.string().max(200),
  website: z.string().max(200).optional(), // honeypot — real users never fill this
});

const SUCCESS_DECOY = "Thanks!";

export async function handleClaim(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") return json(request, { status: "invalid_request", message: "Method not allowed." }, 405);

  const ip = clientIp(request);
  const ipLimit = rateLimit(`claim:ip:${ip}`, 10, 10 * 60_000);
  if (!ipLimit.allowed) {
    return json(request, { status: "rate_limited", message: "Too many attempts. Please try again later." }, 429, {
      "Retry-After": String(ipLimit.retryAfterSec),
    });
  }

  const parsed = claimSchema.safeParse(await readJson(request));
  if (!parsed.success) {
    return json(request, { status: "invalid_request", message: "Invalid request." }, 400);
  }
  const { campaignId, email, token, website } = parsed.data;

  // Honeypot: pretend success, do nothing.
  if (website) return json(request, { status: "success", message: SUCCESS_DECOY });

  const shop = await resolveShop(request, parsed.data.shop);
  if (shop instanceof Response) return shop;

  const emailLimit = rateLimit(`claim:email:${shop}:${normalizeEmail(email)}`, 5, 60 * 60_000);
  if (!emailLimit.allowed) {
    return json(request, { status: "rate_limited", message: "Too many attempts. Please try again later." }, 429, {
      "Retry-After": String(emailLimit.retryAfterSec),
    });
  }

  const tokenState = checkToken(token, shop, campaignId);
  if (tokenState === "too_fast") {
    return json(request, { status: "rate_limited", message: "Please wait a moment and try again." }, 429);
  }
  if (tokenState !== "ok") {
    return json(request, { status: "invalid_request", message: "This form has expired. Please refresh the page." }, 400);
  }

  const result = await processClaim(
    { db, gateway: createShopifyGateway(), mailer: createMailer() },
    { shop, campaignId, email },
  );
  return json(request, result.body, result.httpStatus);
}

/** GET config for the storefront script: only public, non-sensitive fields. */
export async function handleConfig(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  const ipLimit = rateLimit(`config:ip:${clientIp(request)}`, 120, 60_000);
  if (!ipLimit.allowed) return json(request, { campaigns: [] }, 429);

  const shop = await resolveShop(request, new URL(request.url).searchParams.get("shop"));
  if (shop instanceof Response) return shop;

  const campaigns = await db.campaign.findMany({
    where: { shop, active: true },
    orderBy: { updatedAt: "desc" },
    take: 5,
  });
  return json(
    request,
    {
      campaigns: campaigns.map((c) => ({
        id: c.id,
        v: c.updatedAt.getTime(),
        token: issueToken(shop, c.id),
        template: c.template,
        content: {
          title: c.title,
          subtitle: c.subtitle,
          declineText: c.declineText,
          countdownHours: c.showCountdown ? c.countdownHours : 0,
          description: c.description,
          buttonText: c.buttonText,
          emailPlaceholder: c.emailPlaceholder,
          privacyNote: c.privacyNote,
          imageUrl: c.imageUrl,
          errorMessage: c.errorMessage,
        },
        style: {
          backgroundColor: c.backgroundColor,
          textColor: c.textColor,
          buttonColor: c.buttonColor,
          buttonTextColor: c.buttonTextColor,
        },
        rules: {
          trigger: c.triggerMode,
          delaySeconds: c.delaySeconds,
          minPageViews: c.minPageViews,
          frequency: c.frequency,
          frequencyDays: c.frequencyDays,
          stopAfterClaim: c.frequency === "UNTIL_CLAIMED" ? true : c.stopAfterClaim,
          device: c.deviceTarget,
          pages: c.pageTarget,
          paths: c.pagePaths,
        },
      })),
    },
    200,
    { "Cache-Control": "private, max-age=30" },
  );
}

const eventSchema = z.object({
  shop: z.string().max(100).optional(),
  campaignId: z.string().min(1).max(40),
  type: z.literal("view"),
});

/** Popup-view beacon (analytics only). */
export async function handleEvent(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }
  if (request.method !== "POST") return json(request, { ok: false }, 405);
  if (!rateLimit(`event:ip:${clientIp(request)}`, 60, 60_000).allowed) return json(request, { ok: false }, 429);
  const parsed = eventSchema.safeParse(await readJson(request));
  if (!parsed.success) return json(request, { ok: false }, 400);
  const shop = await resolveShop(request, parsed.data.shop);
  if (shop instanceof Response) return shop;
  const campaign = await db.campaign.findFirst({
    where: { id: parsed.data.campaignId, shop },
    select: { id: true },
  });
  if (campaign) await bumpStat(db, shop, campaign.id, "VIEW");
  return json(request, { ok: true });
}

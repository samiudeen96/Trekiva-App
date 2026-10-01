import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeEmail } from "../lib/email-address";

type OrderPayload = {
  email?: string | null;
  customer?: { email?: string | null } | null;
  discount_codes?: { code: string }[];
};

// Marks claims as redeemed when an order uses their discount code (for analytics).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, payload } = await authenticate.webhook(request);
  const order = payload as OrderPayload;
  const codes = (order.discount_codes ?? []).map((d) => d.code).filter(Boolean);
  if (!codes.length) return new Response();

  const orderEmail = normalizeEmail(order.email ?? order.customer?.email ?? "");
  const claims = await db.welcomeClaim.findMany({
    where: {
      shop,
      redeemedAt: null,
      status: "SENT",
      OR: codes.map((code) => ({ discountCode: { equals: code, mode: "insensitive" as const } })),
    },
    select: { id: true, email: true, campaign: { select: { discountMode: true } } },
  });
  // Unique codes are single-use and bound to the claimant: the code alone is proof.
  // A shared code is on many claims, so also require the order email to match.
  const ids = claims
    .filter((c) => c.campaign.discountMode === "UNIQUE" || (orderEmail && c.email === orderEmail))
    .map((c) => c.id);
  if (ids.length) {
    await db.welcomeClaim.updateMany({
      where: { id: { in: ids }, redeemedAt: null },
      data: { redeemedAt: new Date() },
    });
  }
  return new Response();
};

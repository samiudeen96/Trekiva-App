import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless, short-lived form token handed out with the campaign config.
 * A claim must present a token that is (a) signed by us, (b) for the same
 * shop+campaign, (c) at least MIN_AGE_MS old (humans cannot fill a form in
 * <2s) and (d) younger than MAX_AGE_MS. Cheap, effective against naive bots.
 */
export const TOKEN_MIN_AGE_MS = 2_000;
export const TOKEN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

function secret(): string {
  const s = process.env.CLAIM_TOKEN_SECRET || process.env.SHOPIFY_API_SECRET;
  if (!s) throw new Error("CLAIM_TOKEN_SECRET (or SHOPIFY_API_SECRET) must be set");
  return s;
}

function sign(shop: string, campaignId: string, issuedAt: number) {
  return createHmac("sha256", secret())
    .update(`${shop}|${campaignId}|${issuedAt}`)
    .digest("base64url");
}

export function issueToken(shop: string, campaignId: string, now = Date.now()) {
  return `${now}.${sign(shop, campaignId, now)}`;
}

export type TokenCheck = "ok" | "invalid" | "too_fast" | "expired";

export function checkToken(
  token: unknown,
  shop: string,
  campaignId: string,
  now = Date.now(),
): TokenCheck {
  if (typeof token !== "string") return "invalid";
  const [ts, mac] = token.split(".");
  const issuedAt = Number(ts);
  if (!mac || !Number.isFinite(issuedAt)) return "invalid";
  const expected = Buffer.from(sign(shop, campaignId, issuedAt));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return "invalid";
  const age = now - issuedAt;
  if (age < TOKEN_MIN_AGE_MS) return "too_fast";
  if (age > TOKEN_MAX_AGE_MS) return "expired";
  return "ok";
}

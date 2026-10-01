import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeGateway, fakeMailer, db, makeCampaign, resetDb, SHOP } from "./helpers";

const gateway = fakeGateway();
const mailer = fakeMailer();
vi.mock("../app/lib/shopify-gateway.server", () => ({ createShopifyGateway: () => gateway }));
vi.mock("../app/lib/email/mailer.server", () => ({ createMailer: () => mailer }));

const { handleClaim, handleConfig } = await import("../app/lib/public-api.server");
const { issueToken } = await import("../app/lib/bot-token.server");
const { resetRateLimits } = await import("../app/lib/rate-limit.server");

const URL_ = "https://app.example.com/api/public/welcome-claim";
let ipCounter = 0;
function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(URL_, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${++ipCounter}`, ...headers },
    body: JSON.stringify(body),
  });
}
/** A token that is old enough to pass the "too fast" check. */
const oldToken = (campaignId: string) => issueToken(SHOP, campaignId, Date.now() - 10_000);

beforeEach(async () => {
  await resetDb();
  await db.session.deleteMany();
  await db.session.create({ data: { id: "offline_" + SHOP, shop: SHOP, state: "s", isOnline: false, accessToken: "t" } });
  mailer.sent.length = 0;
  resetRateLimits();
});

describe("POST /api/public/welcome-claim", () => {
  it("full flow: new email succeeds, repeat is already_claimed, code never in response", async () => {
    const c = await makeCampaign();
    const body = { shop: SHOP, campaignId: c.id, token: oldToken(c.id) };

    const r1 = await handleClaim(post({ ...body, email: "Flow@Example.com" }));
    const j1 = await r1.json();
    expect(r1.status).toBe(200);
    expect(j1).toEqual({
      status: "success",
      message: "Your 10% welcome offer is on its way! Check your inbox for your discount code.",
    });

    const r2 = await handleClaim(post({ ...body, email: "flow@example.com" }));
    expect(await r2.json()).toEqual({
      status: "already_claimed",
      message: "You've already claimed your welcome offer. Please check your inbox for your discount code.",
    });
    expect(mailer.sent).toHaveLength(1);
    expect(JSON.stringify([j1])).not.toContain("WELCOME10");
  });

  it("rejects a missing, forged, or too-fresh token", async () => {
    const c = await makeCampaign();
    const base = { shop: SHOP, campaignId: c.id, email: "t@example.com" };
    expect((await handleClaim(post({ ...base, token: "nope" }))).status).toBe(400);
    expect((await handleClaim(post({ ...base, token: issueToken(SHOP, c.id) }))).status).toBe(429);
    expect((await handleClaim(post({ ...base }))).status).toBe(400);
    expect(await db.welcomeClaim.count()).toBe(0);
  });

  it("silently ignores honeypot submissions", async () => {
    const c = await makeCampaign();
    const res = await handleClaim(post({ shop: SHOP, campaignId: c.id, email: "bot@example.com", token: oldToken(c.id), website: "http://spam" }));
    expect(res.status).toBe(200);
    expect(await db.welcomeClaim.count()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("rejects unknown / malformed shops", async () => {
    const c = await makeCampaign();
    const t = oldToken(c.id);
    expect((await handleClaim(post({ shop: "evil.com", campaignId: c.id, email: "a@example.com", token: t }))).status).toBe(400);
    expect((await handleClaim(post({ shop: "ghost.myshopify.com", campaignId: c.id, email: "a@example.com", token: issueToken("ghost.myshopify.com", c.id, 0) }))).status).toBe(404);
  });

  it("rejects a tampered shop (token is bound to the shop)", async () => {
    await db.session.create({ data: { id: "offline_b", shop: "b.myshopify.com", state: "s", isOnline: false, accessToken: "t" } });
    const c = await makeCampaign();
    const res = await handleClaim(post({ shop: "b.myshopify.com", campaignId: c.id, email: "a@example.com", token: oldToken(c.id) }));
    expect(res.status).toBe(400);
  });

  it("rate limits repeated attempts from one IP", async () => {
    const c = await makeCampaign();
    const headers = { "x-forwarded-for": "9.9.9.9" };
    let last = 0;
    for (let i = 0; i < 12; i++) {
      last = (await handleClaim(post({ shop: SHOP, campaignId: c.id, email: `u${i}@example.com`, token: "bad" }, headers))).status;
    }
    expect(last).toBe(429);
  });

  it("rejects oversized bodies and non-POST", async () => {
    expect((await handleClaim(post({ email: "x".repeat(10_000) }))).status).toBe(400);
    expect((await handleClaim(new Request(URL_, { method: "GET" }))).status).toBe(405);
  });

  it("only echoes CORS for Shopify storefront origins", async () => {
    const ok = await handleClaim(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://x.myshopify.com" } }));
    expect(ok.headers.get("access-control-allow-origin")).toBe("https://x.myshopify.com");
    const bad = await handleClaim(new Request(URL_, { method: "OPTIONS", headers: { origin: "https://evil.com" } }));
    expect(bad.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("GET /api/public/welcome-config", () => {
  it("returns only active campaigns and only public fields", async () => {
    const active = await makeCampaign({ sharedCode: "SECRETCODE", template: "COUNTDOWN", showCountdown: true, countdownHours: 12, subtitle: "LIMITED TIME OFFER" });
    await makeCampaign({ active: false, name: "off" });
    const res = await handleConfig(new Request(`https://app.example.com/api/public/welcome-config?shop=${SHOP}`));
    const body = await res.json();
    expect(body.campaigns).toHaveLength(1);
    expect(body.campaigns[0].id).toBe(active.id);
    expect(body.campaigns[0].template).toBe("COUNTDOWN");
    expect(body.campaigns[0].content).toMatchObject({ subtitle: "LIMITED TIME OFFER", countdownHours: 12 });
    expect(JSON.stringify(body)).not.toContain("SECRETCODE");
    expect(JSON.stringify(body)).not.toMatch(/accessToken|emailBody|sharedCode|codePrefix/);
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkToken, issueToken, TOKEN_MAX_AGE_MS, TOKEN_MIN_AGE_MS } from "../app/lib/bot-token.server";
import { generateUniqueCode, sanitizePrefix } from "../app/lib/discount-code";
import { isValidEmail, normalizeEmail } from "../app/lib/email-address";
import { renderHtml, renderSubject, renderText } from "../app/lib/email/template";
import { rateLimit, resetRateLimits } from "../app/lib/rate-limit.server";
import { parseCampaignForm } from "../app/lib/campaign-form.server";

describe("email normalization", () => {
  it("trims and lowercases", () => {
    expect(normalizeEmail("  Foo@Bar.COM \n")).toBe("foo@bar.com");
    expect(normalizeEmail(undefined)).toBe("");
    expect(isValidEmail("foo@bar.com")).toBe(true);
    expect(isValidEmail("foo+tag@sub.bar.co.uk")).toBe(true);
  });
});

describe("discount codes", () => {
  it("builds PREFIX-XXXXXX", () => {
    expect(generateUniqueCode("welcome10")).toMatch(/^WELCOME10-[A-Z2-9]{6}$/);
    expect(sanitizePrefix("we lcome-10!")).toBe("WELCOME10");
    expect(sanitizePrefix("")).toBe("WELCOME");
  });
});

describe("email template", () => {
  const vars = { discount_code: "WELCOME10", discount_value: "10%", shop_url: "https://trekiva.com", shop_name: "Trekiva" };
  it("renders the subject and body variables", () => {
    expect(renderSubject("Welcome to {{ shop_name }} — here's {{discount_value}} off\r\nBcc: x", vars)).toBe(
      "Welcome to Trekiva — here's 10% off Bcc: x",
    );
    expect(renderText("Code: {{ discount_code }} at {{ shop_url }}", vars)).toBe("Code: WELCOME10 at https://trekiva.com");
  });
  it("escapes HTML in variables", () => {
    const html = renderHtml("Hi {{ shop_name }}", { ...vars, shop_name: "<script>alert(1)</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
  it("shows the code prominently", () => {
    expect(renderHtml("Use:\n\n{{ discount_code }}", vars)).toContain("WELCOME10</span>");
  });
});

describe("bot token", () => {
  it("accepts a token only inside its age window and for the same campaign", () => {
    const t0 = 1_000_000;
    const token = issueToken("s.myshopify.com", "c1", t0);
    expect(checkToken(token, "s.myshopify.com", "c1", t0 + 500)).toBe("too_fast");
    expect(checkToken(token, "s.myshopify.com", "c1", t0 + TOKEN_MIN_AGE_MS + 1)).toBe("ok");
    expect(checkToken(token, "s.myshopify.com", "c1", t0 + TOKEN_MAX_AGE_MS + 1)).toBe("expired");
    expect(checkToken(token, "s.myshopify.com", "c2", t0 + 5000)).toBe("invalid");
    expect(checkToken(token, "other.myshopify.com", "c1", t0 + 5000)).toBe("invalid");
    expect(checkToken("garbage", "s.myshopify.com", "c1")).toBe("invalid");
    expect(checkToken(undefined, "s.myshopify.com", "c1")).toBe("invalid");
  });
});

describe("rate limit", () => {
  it("blocks after the limit and recovers after the window", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 1000, 0).allowed).toBe(true);
    expect(rateLimit("k", 3, 1000, 10).allowed).toBe(false);
    expect(rateLimit("k", 3, 1000, 1001).allowed).toBe(true);
  });
});

describe("campaign form validation", () => {
  const base = {
    name: "n", template: "SPLIT", subtitle: "", countdownHours: "24", declineText: "No, thanks!", title: "t", description: "", buttonText: "b", emailPlaceholder: "", successMessage: "s",
    alreadyClaimedMessage: "a", notEligibleMessage: "n", errorMessage: "e", privacyNote: "",
    backgroundColor: "#ffffff", textColor: "#000000", buttonColor: "#000000", buttonTextColor: "#ffffff", imageUrl: "",
    discountType: "PERCENTAGE", discountValue: "10", discountMode: "SHARED", sharedCode: "WELCOME10", codePrefix: "W",
    expiryDays: "", customerTag: "welcome10_claimed", triggerMode: "DELAY", delaySeconds: "5", minPageViews: "1",
    frequency: "ONCE_PER_SESSION", frequencyDays: "7", deviceTarget: "ALL", pageTarget: "ALL", pagePaths: "",
    emailSubject: "s", emailBody: "Code: {{ discount_code }}", emailFromName: "", emailFromAddress: "", emailReplyTo: "",
  };
  const form = (o: Record<string, string>) => {
    const f = new FormData();
    for (const [k, v] of Object.entries({ ...base, ...o })) f.set(k, v);
    return f;
  };
  it("accepts a valid campaign and coerces types", () => {
    const r = parseCampaignForm(form({ active: "on", pageTarget: "SELECTED", pagePaths: "/\ncollections/*" }));
    expect(r.ok && r.data).toMatchObject({ active: true, discountValue: 10, expiryDays: null, pagePaths: ["/", "/collections/*"], createCustomer: false });
  });
  it("parses template fields", () => {
    const r = parseCampaignForm(form({ template: "COUNTDOWN", subtitle: "LIMITED TIME OFFER", showCountdown: "on" }));
    expect(r.ok && r.data).toMatchObject({ template: "COUNTDOWN", subtitle: "LIMITED TIME OFFER", showCountdown: true, countdownHours: 24 });
    expect(parseCampaignForm(form({ template: "NOPE" })).ok).toBe(false);
  });
  it("rejects bad input", () => {
    expect(parseCampaignForm(form({ discountValue: "150" })).ok).toBe(false);
    expect(parseCampaignForm(form({ sharedCode: "" })).ok).toBe(false);
    expect(parseCampaignForm(form({ emailBody: "no code here" })).ok).toBe(false);
    expect(parseCampaignForm(form({ backgroundColor: "red" })).ok).toBe(false);
    expect(parseCampaignForm(form({ pageTarget: "SELECTED", pagePaths: "" })).ok).toBe(false);
  });
});

// ---- Storefront display rules (extensions/welcome-popup/assets/welcome-popup.js) ----
type Rules = Record<string, unknown>;
const mod = {
  exports: {} as {
    qualifies: (r: Rules, e: Rules, state: Rules, session: Rules) => boolean;
    matchPath: (patterns: string[], path: string) => boolean;
  },
};
new Function("module", readFileSync("extensions/welcome-popup/assets/welcome-popup.js", "utf8"))(mod);
const { qualifies, matchPath } = mod.exports;

describe("popup display rules", () => {
  const rules = (o = {}) => ({
    device: "ALL", pages: "ALL", paths: [], stopAfterClaim: true, minPageViews: 1,
    frequency: "EVERY_PAGE_LOAD", frequencyDays: 7, ...o,
  });
  const env = (o = {}) => ({ now: 10 * 86_400_000, path: "/", isMobile: false, pageViews: 1, isReload: false, ...o });
  const none = {};

  it("matches paths exactly, with trailing slashes ignored, and by wildcard", () => {
    expect(matchPath(["/"], "/")).toBe(true);
    expect(matchPath(["/pages/about"], "/pages/about/")).toBe(true);
    expect(matchPath(["/collections/*"], "/collections/shoes")).toBe(true);
    expect(matchPath(["/collections/*"], "/products/x")).toBe(false);
  });
  it("respects device targeting", () => {
    expect(qualifies(rules({ device: "DESKTOP" }), env({ isMobile: true }), none, none)).toBe(false);
    expect(qualifies(rules({ device: "MOBILE" }), env({ isMobile: true }), none, none)).toBe(true);
    expect(qualifies(rules({ device: "MOBILE" }), env(), none, none)).toBe(false);
  });
  it("respects selected pages", () => {
    const r = rules({ pages: "SELECTED", paths: ["/collections/*"] });
    expect(qualifies(r, env({ path: "/collections/a" }), none, none)).toBe(true);
    expect(qualifies(r, env({ path: "/" }), none, none)).toBe(false);
  });
  it("waits for the Nth page view", () => {
    const r = rules({ minPageViews: 3 });
    expect(qualifies(r, env({ pageViews: 2 }), none, none)).toBe(false);
    expect(qualifies(r, env({ pageViews: 3 }), none, none)).toBe(true);
  });
  it("once per session", () => {
    const r = rules({ frequency: "ONCE_PER_SESSION" });
    expect(qualifies(r, env(), none, none)).toBe(true);
    expect(qualifies(r, env(), none, { shown: true })).toBe(false);
  });
  it("once every X days", () => {
    const r = rules({ frequency: "ONCE_EVERY_X_DAYS", frequencyDays: 7 });
    const now = 10 * 86_400_000;
    expect(qualifies(r, env({ now }), { lastShown: now - 3 * 86_400_000 }, none)).toBe(false);
    expect(qualifies(r, env({ now }), { lastShown: now - 8 * 86_400_000 }, none)).toBe(true);
  });
  it("every refresh: shows again after reload even if already shown this session", () => {
    const r = rules({ frequency: "EVERY_REFRESH", stopAfterClaim: false });
    expect(qualifies(r, env({ isReload: true }), { claimed: true }, { shown: true })).toBe(true);
    expect(qualifies(r, env(), none, { shown: true })).toBe(false); // plain navigation
  });
  it("every refresh stops after a claim only when stop-after-claim is on", () => {
    const on = rules({ frequency: "EVERY_REFRESH", stopAfterClaim: true });
    expect(qualifies(on, env({ isReload: true }), { claimed: true }, none)).toBe(false);
  });
  it("show until claimed keeps showing, then stops", () => {
    const r = rules({ frequency: "UNTIL_CLAIMED" });
    expect(qualifies(r, env(), { lastShown: 1 }, { shown: true })).toBe(true);
    expect(qualifies(r, env(), { claimed: true }, none)).toBe(false);
  });
  it("preview bypasses every rule", () => {
    expect(qualifies(rules({ device: "MOBILE" }), env({ preview: true }), { claimed: true }, { shown: true })).toBe(true);
  });
});

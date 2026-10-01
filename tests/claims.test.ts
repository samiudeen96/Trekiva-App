import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it } from "vitest";
import { processClaim } from "../app/lib/claims.server";
import { db, fakeGateway, fakeMailer, makeCampaign, resetDb, SHOP } from "./helpers";

const SUCCESS = "Your 10% welcome offer is on its way! Check your inbox for your discount code.";
const DUPLICATE =
  "You've already claimed your welcome offer. Please check your inbox for your discount code.";

let gateway = fakeGateway();
let mailer = fakeMailer();
const claim = (campaignId: string, email: string) =>
  processClaim({ db, gateway, mailer }, { shop: SHOP, campaignId, email });

beforeEach(async () => {
  await resetDb();
  gateway = fakeGateway();
  mailer = fakeMailer();
});

describe("claiming", () => {
  it("first email claim succeeds, stores the claim and emails the code", async () => {
    const c = await makeCampaign();
    const res = await claim(c.id, "new@example.com");

    expect(res.httpStatus).toBe(200);
    expect(res.body).toEqual({ status: "success", message: SUCCESS });
    const rows = await db.welcomeClaim.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: "new@example.com", status: "SENT", discountCode: "WELCOME10" });
    expect(rows[0].emailSentAt).toBeInstanceOf(Date);
    expect(rows[0].shopifyCustomerId).toBeTruthy();
    expect(mailer.sent).toEqual([expect.objectContaining({ to: "new@example.com", code: "WELCOME10" })]);
    expect(gateway.calls.createCustomer).toBe(1);
  });

  it("never returns the discount code to the browser", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE" });
    const res = await claim(c.id, "a@example.com");
    const row = await db.welcomeClaim.findFirstOrThrow();
    expect(JSON.stringify(res)).not.toContain(row.discountCode!);
    expect(Object.keys(res.body).sort()).toEqual(["message", "status"]);
  });

  it("rejects a second claim from the same email without sending or creating anything", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE" });
    await claim(c.id, "dup@example.com");
    const second = await claim(c.id, "dup@example.com");

    expect(second.body).toEqual({ status: "already_claimed", message: DUPLICATE });
    expect(await db.welcomeClaim.count()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(gateway.calls.createDiscount).toBe(1);
  });

  it("treats upper/lower-case variants as the same email", async () => {
    const c = await makeCampaign();
    await claim(c.id, "Person@Example.COM");
    const res = await claim(c.id, "person@example.com");
    expect(res.body.status).toBe("already_claimed");
    expect((await db.welcomeClaim.findFirstOrThrow()).email).toBe("person@example.com");
  });

  it("trims whitespace before comparing and storing", async () => {
    const c = await makeCampaign();
    await claim(c.id, "  ws@example.com  ");
    const res = await claim(c.id, "ws@example.com\n");
    expect(res.body.status).toBe("already_claimed");
    expect((await db.welcomeClaim.findFirstOrThrow()).email).toBe("ws@example.com");
  });

  it("lets the same email claim a different campaign", async () => {
    const a = await makeCampaign({ name: "A" });
    const b = await makeCampaign({ name: "B" });
    expect((await claim(a.id, "same@example.com")).body.status).toBe("success");
    expect((await claim(b.id, "same@example.com")).body.status).toBe("success");
    expect(await db.welcomeClaim.count()).toBe(2);
  });

  it("creates only one claim, one discount and one email for simultaneous duplicate requests", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE" });
    const results = await Promise.all(
      Array.from({ length: 25 }, (_, i) => claim(c.id, i % 2 ? "Race@Example.com" : " race@example.com")),
    );

    expect(results.filter((r) => r.body.status === "success")).toHaveLength(1);
    expect(results.filter((r) => r.body.status === "already_claimed")).toHaveLength(24);
    expect(await db.welcomeClaim.count()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
    expect(gateway.calls.createDiscount).toBe(1);
  });

  it("enforces uniqueness in the database itself", async () => {
    const c = await makeCampaign();
    const data = { shop: SHOP, campaignId: c.id, email: "db@example.com" };
    await db.welcomeClaim.create({ data });
    await expect(db.welcomeClaim.create({ data })).rejects.toMatchObject({
      code: "P2002",
      constructor: Prisma.PrismaClientKnownRequestError,
    });
  });
});

describe("validation", () => {
  it("rejects an inactive campaign", async () => {
    const c = await makeCampaign({ active: false });
    const res = await claim(c.id, "x@example.com");
    expect(res.httpStatus).toBe(404);
    expect(res.body.status).toBe("campaign_unavailable");
    expect(await db.welcomeClaim.count()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it("rejects a campaign that belongs to another shop", async () => {
    const c = await makeCampaign({ shop: "other.myshopify.com" });
    expect((await claim(c.id, "x@example.com")).body.status).toBe("campaign_unavailable");
  });

  it.each(["", "   ", "not-an-email", "a@b", "a b@example.com", "@example.com", "a..b@example.com", "x@example"])(
    "rejects invalid email %j",
    async (email) => {
      const c = await makeCampaign();
      const res = await claim(c.id, email);
      expect(res.httpStatus).toBe(400);
      expect(res.body.status).toBe("invalid_email");
      expect(await db.welcomeClaim.count()).toBe(0);
    },
  );
});

describe("discounts", () => {
  it("generates a unique single-use code bound to the customer", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE", codePrefix: "WELCOME10", expiryDays: 14 });
    await claim(c.id, "u@example.com");
    const row = await db.welcomeClaim.findFirstOrThrow();

    expect(row.discountCode).toMatch(/^WELCOME10-[A-HJ-NP-Z2-9]{6}$/);
    expect(row.shopifyDiscountId).toBeTruthy();
    expect(gateway.discountsCreated).toEqual([
      { code: row.discountCode, customerId: row.shopifyCustomerId, usageLimit: 1 },
    ]);
    expect(mailer.sent[0].code).toBe(row.discountCode);
  });

  it("gives different customers different unique codes", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE" });
    await claim(c.id, "one@example.com");
    await claim(c.id, "two@example.com");
    const codes = (await db.welcomeClaim.findMany()).map((r) => r.discountCode);
    expect(new Set(codes).size).toBe(2);
  });

  it("uses the shared code without creating a Shopify discount", async () => {
    const c = await makeCampaign({ discountMode: "SHARED", sharedCode: "WELCOME10" });
    await claim(c.id, "s@example.com");
    expect(gateway.calls.createDiscount).toBe(0);
    expect(mailer.sent[0].code).toBe("WELCOME10");
  });

  it("tags a pre-existing customer and does not create a duplicate customer", async () => {
    const c = await makeCampaign();
    gateway.existingCustomers.set("known@example.com", { id: "gid://shopify/Customer/99", ordersCount: 0 });
    await claim(c.id, "known@example.com");
    expect(gateway.calls.createCustomer).toBe(0);
    expect(gateway.calls.tags).toBe(1);
    expect((await db.welcomeClaim.findFirstOrThrow()).shopifyCustomerId).toBe("gid://shopify/Customer/99");
  });
});

describe("first-order eligibility", () => {
  it("blocks existing customers who already have orders (no email, no discount)", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE", firstOrderOnly: true });
    gateway.existingCustomers.set("old@example.com", { id: "gid://shopify/Customer/7", ordersCount: 3 });
    const res = await claim(c.id, "old@example.com");

    expect(res.body.status).toBe("not_eligible");
    expect(mailer.sent).toHaveLength(0);
    expect(gateway.calls.createDiscount).toBe(0);
    expect((await db.welcomeClaim.findFirstOrThrow()).status).toBe("INELIGIBLE");
    // and stays blocked on retry
    expect((await claim(c.id, "old@example.com")).body.status).toBe("not_eligible");
  });

  it("allows customers with orders when first-order-only is off", async () => {
    const c = await makeCampaign({ firstOrderOnly: false });
    gateway.existingCustomers.set("old@example.com", { id: "gid://shopify/Customer/7", ordersCount: 3 });
    expect((await claim(c.id, "old@example.com")).body.status).toBe("success");
  });
});

describe("failures", () => {
  it("handles an email-provider failure: claim kept, error returned, no duplicate discount on retry", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE" });
    mailer.failNext = 1;

    const first = await claim(c.id, "fail@example.com");
    expect(first.httpStatus).toBe(502);
    expect(first.body.status).toBe("error");
    const failed = await db.welcomeClaim.findFirstOrThrow();
    expect(failed.status).toBe("EMAIL_FAILED");
    expect(failed.lastError).toContain("provider down");
    expect(failed.discountCode).toBeTruthy();
    expect(mailer.sent).toHaveLength(0);

    const retry = await claim(c.id, "fail@example.com");
    expect(retry.body).toEqual({ status: "success", message: SUCCESS });
    expect(await db.welcomeClaim.count()).toBe(1);
    expect(gateway.calls.createDiscount).toBe(1); // reused, not re-created
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0].code).toBe(failed.discountCode);

    // now completed -> further attempts are duplicates
    expect((await claim(c.id, "fail@example.com")).body.status).toBe("already_claimed");
    expect(mailer.sent).toHaveLength(1);
  });

  it("only one of several concurrent retries resumes a failed claim", async () => {
    const c = await makeCampaign();
    mailer.failNext = 1;
    await claim(c.id, "r@example.com");
    const results = await Promise.all(Array.from({ length: 10 }, () => claim(c.id, "r@example.com")));
    expect(results.filter((r) => r.body.status === "success")).toHaveLength(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it("records a Shopify failure as retryable without emailing", async () => {
    const c = await makeCampaign({ discountMode: "UNIQUE" });
    const original = gateway.createUniqueDiscount;
    gateway.createUniqueDiscount = async () => {
      throw new Error("Shopify 500");
    };
    const res = await claim(c.id, "s@example.com");
    expect(res.body.status).toBe("error");
    expect((await db.welcomeClaim.findFirstOrThrow()).status).toBe("FAILED");
    expect(mailer.sent).toHaveLength(0);

    gateway.createUniqueDiscount = original;
    expect((await claim(c.id, "s@example.com")).body.status).toBe("success");
  });

  it("stops retrying after the attempt limit", async () => {
    const c = await makeCampaign();
    mailer.failNext = 99;
    for (let i = 0; i < 5; i++) expect((await claim(c.id, "limit@example.com")).body.status).toBe("error");
    expect((await claim(c.id, "limit@example.com")).body.status).toBe("already_claimed");
  });
});

describe("analytics counters", () => {
  it("counts submissions, claims, duplicates and emails", async () => {
    const c = await makeCampaign();
    await claim(c.id, "a@example.com");
    await claim(c.id, "a@example.com");
    const stats = Object.fromEntries(
      (await db.campaignDailyStat.findMany()).map((s) => [s.type, s.count]),
    );
    expect(stats).toMatchObject({ SUBMISSION: 2, CLAIM: 1, DUPLICATE: 1, EMAIL_SENT: 1 });
  });
});

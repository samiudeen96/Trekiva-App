import { PrismaClient, type Campaign } from "@prisma/client";
import type { Mailer } from "../app/lib/email/mailer.server";
import type { ShopifyGateway } from "../app/lib/shopify-gateway.server";

export const db = new PrismaClient();
export const SHOP = "test-shop.myshopify.com";

export async function resetDb() {
  await db.campaignDailyStat.deleteMany();
  await db.welcomeClaim.deleteMany();
  await db.campaign.deleteMany();
}

export function makeCampaign(overrides: Partial<Campaign> = {}) {
  return db.campaign.create({
    data: { shop: SHOP, name: "Welcome 10%", active: true, ...overrides } as never,
  });
}

export type FakeGateway = ShopifyGateway & {
  calls: { createCustomer: number; createDiscount: number; tags: number };
  existingCustomers: Map<string, { id: string; ordersCount: number }>;
  discountsCreated: { code: string; customerId: string | null; usageLimit: number }[];
};

export function fakeGateway(): FakeGateway {
  const calls = { createCustomer: 0, createDiscount: 0, tags: 0 };
  const existingCustomers = new Map<string, { id: string; ordersCount: number }>();
  const discountsCreated: FakeGateway["discountsCreated"] = [];
  return {
    calls,
    existingCustomers,
    discountsCreated,
    async getShopInfo() {
      return { name: "Trekiva", url: "https://trekiva.example" };
    },
    async findCustomerByEmail(_s, email) {
      return existingCustomers.get(email) ?? null;
    },
    async createCustomer(_s, email) {
      calls.createCustomer++;
      const c = { id: `gid://shopify/Customer/${calls.createCustomer}`, ordersCount: 0 };
      existingCustomers.set(email, c);
      return c;
    },
    async addCustomerTag() {
      calls.tags++;
    },
    async createUniqueDiscount(_s, { code, customerId }) {
      calls.createDiscount++;
      discountsCreated.push({ code, customerId, usageLimit: 1 });
      return { discountId: `gid://shopify/DiscountCodeNode/${calls.createDiscount}`, code };
    },
    async discountCodeExists() {
      return true;
    },
    async listCodeDiscounts() {
      return [];
    },
  };
}

export type FakeMailer = Mailer & {
  sent: { to: string; code: string; subject: string }[];
  failNext: number;
};

export function fakeMailer(): FakeMailer {
  const m: FakeMailer = {
    sent: [],
    failNext: 0,
    async sendDiscountEmail({ to, vars }) {
      if (m.failNext > 0) {
        m.failNext--;
        throw new Error("provider down");
      }
      m.sent.push({ to, code: vars.discount_code, subject: "" });
    },
  };
  return m;
}

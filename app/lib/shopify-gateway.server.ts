import type { Campaign } from "@prisma/client";
import { unauthenticated } from "../shopify.server";
import { DiscountCodeTakenError } from "./shopify-errors";

export type ShopInfo = { name: string; url: string };
export type ShopDiscount = {
  code: string;
  title: string;
  summary: string; // "10% off"
  /** true when Shopify itself limits the discount to specific customers / segments. */
  customerRestricted: boolean;
};
export type CustomerRef = { id: string; ordersCount: number };

export { DiscountCodeTakenError };

/**
 * Everything the claim flow needs from Shopify, behind an interface so it can be
 * faked in tests. All calls use the Admin GraphQL API with the shop's offline token
 * (never exposed to the browser).
 */
export interface ShopifyGateway {
  getShopInfo(shop: string): Promise<ShopInfo>;
  findCustomerByEmail(shop: string, email: string): Promise<CustomerRef | null>;
  createCustomer(shop: string, email: string, tags: string[]): Promise<CustomerRef>;
  addCustomerTag(shop: string, customerId: string, tag: string): Promise<void>;
  createUniqueDiscount(
    shop: string,
    args: { campaign: Campaign; code: string; customerId: string | null },
  ): Promise<{ discountId: string; code: string }>;
  discountCodeExists(shop: string, code: string): Promise<boolean>;
  /** Active code discounts from Shopify's native Discounts, for the admin picker. */
  listCodeDiscounts(shop: string): Promise<ShopDiscount[]>;
}

type Gql = (query: string, opts?: { variables?: Record<string, unknown> }) => Promise<Response>;

async function gql<T>(admin: { graphql: Gql }, query: string, variables: Record<string, unknown>) {
  const res = await admin.graphql(query, { variables });
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`Shopify GraphQL error: ${body.errors.map((e) => e.message).join("; ")}`);
  }
  return body.data as T;
}

type UserErrors = { field?: string[]; message: string; code?: string }[];
function throwUserErrors(op: string, errors: UserErrors | undefined) {
  if (errors?.length) throw new Error(`${op}: ${errors.map((e) => e.message).join("; ")}`);
}

const SHOP_CACHE = new Map<string, { at: number; info: ShopInfo }>();

export function createShopifyGateway(): ShopifyGateway {
  const adminFor = async (shop: string) => (await unauthenticated.admin(shop)).admin;

  return {
    async getShopInfo(shop) {
      const cached = SHOP_CACHE.get(shop);
      if (cached && Date.now() - cached.at < 10 * 60_000) return cached.info;
      const admin = await adminFor(shop);
      const data = await gql<{ shop: { name: string; primaryDomain: { url: string } } }>(
        admin,
        `#graphql
        query WelcomeShopInfo { shop { name primaryDomain { url } } }`,
        {},
      );
      const info = { name: data.shop.name, url: data.shop.primaryDomain.url };
      SHOP_CACHE.set(shop, { at: Date.now(), info });
      return info;
    },

    async findCustomerByEmail(shop, email) {
      const admin = await adminFor(shop);
      const data = await gql<{
        customerByIdentifier: { id: string; numberOfOrders: string } | null;
      }>(
        admin,
        `#graphql
        query WelcomeFindCustomer($email: String!) {
          customerByIdentifier(identifier: { emailAddress: $email }) { id numberOfOrders }
        }`,
        { email },
      );
      const c = data.customerByIdentifier;
      return c ? { id: c.id, ordersCount: Number(c.numberOfOrders) } : null;
    },

    async createCustomer(shop, email, tags) {
      const admin = await adminFor(shop);
      const data = await gql<{
        customerCreate: { customer: { id: string } | null; userErrors: UserErrors };
      }>(
        admin,
        `#graphql
        mutation WelcomeCreateCustomer($input: CustomerInput!) {
          customerCreate(input: $input) {
            customer { id }
            userErrors { field message }
          }
        }`,
        { input: { email, tags } },
      );
      throwUserErrors("customerCreate", data.customerCreate.userErrors);
      if (!data.customerCreate.customer) throw new Error("customerCreate returned no customer");
      return { id: data.customerCreate.customer.id, ordersCount: 0 };
    },

    async addCustomerTag(shop, customerId, tag) {
      const admin = await adminFor(shop);
      const data = await gql<{ tagsAdd: { userErrors: UserErrors } }>(
        admin,
        `#graphql
        mutation WelcomeTagCustomer($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) { userErrors { message } }
        }`,
        { id: customerId, tags: [tag] },
      );
      throwUserErrors("tagsAdd", data.tagsAdd.userErrors);
    },

    async createUniqueDiscount(shop, { campaign, code, customerId }) {
      const admin = await adminFor(shop);
      const value =
        campaign.discountType === "PERCENTAGE"
          ? { percentage: Number(campaign.discountValue) / 100 }
          : { discountAmount: { amount: String(campaign.discountValue), appliesOnEachItem: false } };
      const startsAt = new Date();
      const endsAt = campaign.expiryDays
        ? new Date(startsAt.getTime() + campaign.expiryDays * 86_400_000)
        : null;
      const input = {
        title: `${campaign.name} — ${code}`,
        code,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt?.toISOString() ?? null,
        // Hard cap: this code can be redeemed exactly once.
        usageLimit: 1,
        appliesOncePerCustomer: campaign.oncePerCustomer,
        // Bind to the claiming customer so the code is useless to anyone else.
        context: customerId ? { customers: { add: [customerId] } } : { all: "ALL" },
        customerGets: { value, items: { all: true } },
        combinesWith: { orderDiscounts: false, productDiscounts: false, shippingDiscounts: true },
      };
      const data = await gql<{
        discountCodeBasicCreate: {
          codeDiscountNode: { id: string } | null;
          userErrors: UserErrors;
        };
      }>(
        admin,
        `#graphql
        mutation WelcomeCreateDiscount($input: DiscountCodeBasicInput!) {
          discountCodeBasicCreate(basicCodeDiscount: $input) {
            codeDiscountNode { id }
            userErrors { field code message }
          }
        }`,
        { input },
      );
      const { codeDiscountNode, userErrors } = data.discountCodeBasicCreate;
      if (userErrors?.some((e) => e.code === "TAKEN" || /unique|taken|already/i.test(e.message))) {
        throw new DiscountCodeTakenError(code);
      }
      throwUserErrors("discountCodeBasicCreate", userErrors);
      if (!codeDiscountNode) throw new Error("discountCodeBasicCreate returned no discount");
      return { discountId: codeDiscountNode.id, code };
    },

    async discountCodeExists(shop, code) {
      const admin = await adminFor(shop);
      const data = await gql<{ codeDiscountNodeByCode: { id: string } | null }>(
        admin,
        `#graphql
        query WelcomeDiscountByCode($code: String!) {
          codeDiscountNodeByCode(code: $code) { id }
        }`,
        { code },
      );
      return Boolean(data.codeDiscountNodeByCode);
    },
    async listCodeDiscounts(shop) {
      const admin = await adminFor(shop);
      type Node = {
        codeDiscount: {
          __typename: string;
          title?: string;
          codes?: { nodes: { code: string }[] };
          context?: { __typename: string };
          customerGets?: {
            value: { __typename: string; percentage?: number; amount?: { amount: string; currencyCode: string } };
          };
        };
      };
      const data = await gql<{ codeDiscountNodes: { nodes: Node[] } }>(
        admin,
        `#graphql
        query WelcomeListDiscounts {
          codeDiscountNodes(first: 100, query: "status:active", sortKey: CREATED_AT, reverse: true) {
            nodes {
              codeDiscount {
                __typename
                ... on DiscountCodeBasic {
                  title
                  codes(first: 1) { nodes { code } }
                  context { __typename }
                  customerGets {
                    value {
                      __typename
                      ... on DiscountPercentage { percentage }
                      ... on DiscountAmount { amount { amount currencyCode } }
                    }
                  }
                }
              }
            }
          }
        }`,
        {},
      );
      const out: ShopDiscount[] = [];
      for (const n of data.codeDiscountNodes.nodes) {
        const d = n.codeDiscount;
        const code = d.codes?.nodes[0]?.code;
        // Only simple "amount off" code discounts; skip the single-customer codes this app generates.
        if (d.__typename !== "DiscountCodeBasic" || !code || d.context?.__typename === "DiscountCustomers") continue;
        const v = d.customerGets?.value;
        const summary =
          v?.__typename === "DiscountPercentage" && v.percentage != null
            ? `${Math.round(v.percentage * 10000) / 100}% off`
            : v?.amount
              ? `${v.amount.amount} ${v.amount.currencyCode} off`
              : "discount";
        out.push({
          code,
          title: d.title ?? code,
          summary,
          customerRestricted: d.context?.__typename === "DiscountCustomerSegments",
        });
      }
      return out;
    },
  };
}

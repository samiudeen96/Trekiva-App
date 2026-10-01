import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { normalizeEmail } from "../lib/email-address";

// Mandatory privacy webhooks (HMAC-verified by authenticate.webhook).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "CUSTOMERS_REDACT": {
      const email = normalizeEmail((payload as { customer?: { email?: string } }).customer?.email);
      if (email) await db.welcomeClaim.deleteMany({ where: { shop, email } });
      break;
    }
    case "SHOP_REDACT":
      // Cascades to claims and stats.
      await db.campaign.deleteMany({ where: { shop } });
      await db.session.deleteMany({ where: { shop } });
      break;
    case "CUSTOMERS_DATA_REQUEST":
      // The only personal data we hold is the claim row (email, code, timestamps), which the
      // merchant can export from the claims table; nothing further to return automatically.
      break;
  }
  return new Response();
};

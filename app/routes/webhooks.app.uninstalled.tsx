import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  console.log(`Received ${topic} webhook for ${shop}`);

  // Idempotent (webhooks can repeat or arrive after a previous cleanup):
  //  - drop the credentials, and stop the popup immediately by deactivating campaigns.
  //  - claims/campaigns are kept until `shop/redact` (sent ~48h later), so a quick
  //    reinstall does not lose data or let customers re-claim.
  await db.session.deleteMany({ where: { shop } });
  await db.campaign.updateMany({ where: { shop }, data: { active: false } });

  return new Response();
};

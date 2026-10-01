import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [active, claims] = await Promise.all([
    db.campaign.count({ where: { shop: session.shop, active: true } }),
    db.welcomeClaim.count({ where: { shop: session.shop, status: "SENT" } }),
  ]);
  return { active, claims };
};

// Add future tools here; each one gets its own nav link in app.tsx and a /app/<tool> route tree.
export default function Home() {
  const { active, claims } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Trekiva App">
      <s-section heading="Your tools">
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(260px, 1fr))" gap="base">
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-heading>Popup</s-heading>
              <s-paragraph>
                Welcome-discount popups with ready-made templates. Collect emails and send a
                first-order offer.
              </s-paragraph>
              <s-text color="subdued">{active} active campaign(s) · {claims} offers sent</s-text>
              <s-button variant="primary" href="/app/popup">Open Popup</s-button>
            </s-stack>
          </s-box>
          <s-box padding="base" borderWidth="base" borderRadius="base">
            <s-stack gap="small">
              <s-heading>More coming soon</s-heading>
              <s-paragraph color="subdued">New Trekiva tools will appear here and in the left menu.</s-paragraph>
            </s-stack>
          </s-box>
        </s-grid>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

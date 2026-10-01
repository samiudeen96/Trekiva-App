import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useLoaderData, useNavigation } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { embedActivationUrl } from "../lib/embed-link";
import { PopupSubnav } from "../components/PopupSubnav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const campaigns = await db.campaign.findMany({
    where: { shop: session.shop },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { claims: { where: { status: "SENT" } } } } },
  });
  return {
    campaigns: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      active: c.active,
      discountMode: c.discountMode,
      claims: c._count.claims,
    })),
    embedUrl: embedActivationUrl(session.shop, process.env.SHOPIFY_API_KEY ?? ""),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  // New campaigns start inactive with the schema defaults (the WELCOME10 10%-off setup).
  const campaign = await db.campaign.create({
    data: { shop: session.shop, name: "Welcome 10% off", active: false },
  });
  return redirect(`/app/popup/campaigns/${campaign.id}`);
};

export default function Campaigns() {
  const { campaigns, embedUrl } = useLoaderData<typeof loader>();
  const busy = useNavigation().state !== "idle";

  return (
    <s-page heading="Popup" back-action-url="/app">
      <Form method="post" slot="primary-action">
        <s-button variant="primary" type="submit" {...(busy ? { loading: true } : {})}>
          Create campaign
        </s-button>
      </Form>

      <PopupSubnav active="campaigns" />

      <s-banner heading="Turn on the popup in your theme" tone="info">
        <s-paragraph>
          The popup only appears once the app embed is enabled for your live theme.
        </s-paragraph>
        <s-button slot="secondary-actions" href={embedUrl} target="_blank">
          Open theme editor
        </s-button>
      </s-banner>

      <s-section heading="Campaigns">
        {campaigns.length === 0 ? (
          <s-paragraph>
            No campaigns yet. Create one to start collecting emails with a 10% first-order offer.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Name</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Discount</s-table-header>
              <s-table-header>Claims</s-table-header>
              <s-table-header></s-table-header>
            </s-table-header-row>
            <s-table-body>
              {campaigns.map((c) => (
                <s-table-row key={c.id}>
                  <s-table-cell>{c.name}</s-table-cell>
                  <s-table-cell>
                    <s-badge tone={c.active ? "success" : "neutral"}>
                      {c.active ? "Active" : "Inactive"}
                    </s-badge>
                  </s-table-cell>
                  <s-table-cell>{c.discountMode === "UNIQUE" ? "Unique codes" : "Shared code"}</s-table-cell>
                  <s-table-cell>{c.claims}</s-table-cell>
                  <s-table-cell>
                    <s-link href={`/app/popup/campaigns/${c.id}`}>Edit</s-link>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

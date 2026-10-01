import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { embedActivationUrl } from "../lib/embed-link";
import { PopupSubnav } from "../components/PopupSubnav";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const provider = (process.env.EMAIL_PROVIDER || "log").toLowerCase();
  return {
    embedUrl: embedActivationUrl(session.shop, process.env.SHOPIFY_API_KEY ?? ""),
    proxyUrl: `https://${session.shop}/apps/welcome-popup/welcome-config?shop=${session.shop}`,
    provider,
    providerIsReal: provider !== "log",
    fromConfigured: Boolean(process.env.EMAIL_FROM_ADDRESS),
    tokenSecret: Boolean(process.env.CLAIM_TOKEN_SECRET),
  };
};

export default function Setup() {
  const d = useLoaderData<typeof loader>();
  return (
    <s-page heading="Popup" back-action-url="/app">
      <PopupSubnav active="setup" />
      <s-section heading="1. Enable the app embed">
        <s-paragraph>Turn on “Welcome popup” under Theme settings → App embeds, then save.</s-paragraph>
        <s-button href={d.embedUrl} target="_blank">Open theme editor</s-button>
      </s-section>
      <s-section heading="2. Email delivery">
        <s-banner tone={d.providerIsReal && d.fromConfigured ? "success" : "warning"}>
          Provider: {d.provider}. Sender address {d.fromConfigured ? "configured" : "missing (EMAIL_FROM_ADDRESS)"}.
          {!d.providerIsReal && " The “log” provider only prints emails to the server log — customers receive nothing."}
        </s-banner>
      </s-section>
      <s-section heading="3. Server secrets">
        <s-banner tone={d.tokenSecret ? "success" : "warning"}>
          {d.tokenSecret ? "CLAIM_TOKEN_SECRET is set." : "CLAIM_TOKEN_SECRET is not set; falling back to SHOPIFY_API_SECRET."}
        </s-banner>
      </s-section>
      <s-section heading="4. Verify the storefront proxy">
        <s-paragraph>Opening this URL should return JSON with your active campaigns:</s-paragraph>
        <s-link href={d.proxyUrl} target="_blank">{d.proxyUrl}</s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

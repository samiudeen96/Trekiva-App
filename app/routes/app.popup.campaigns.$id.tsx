import { useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useFetcher, useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { parseCampaignForm } from "../lib/campaign-form.server";
import { formatDiscountValue } from "../lib/claims.server";
import { isValidEmail, normalizeEmail } from "../lib/email-address";
import { createMailer } from "../lib/email/mailer.server";
import { rateLimit } from "../lib/rate-limit.server";
import { createShopifyGateway } from "../lib/shopify-gateway.server";
import { PopupSubnav } from "../components/PopupSubnav";
import { TEMPLATES, type TemplateId } from "../lib/templates";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const c = await db.campaign.findFirst({ where: { id: params.id, shop: session.shop } });
  if (!c) throw new Response("Campaign not found", { status: 404 });
  // Native Shopify discounts for the picker; the editor still works (manual entry) if this fails.
  const discounts = await createShopifyGateway().listCodeDiscounts(session.shop).catch(() => null);
  return {
    discounts,
    campaign: {
      ...c,
      discountValue: Number(c.discountValue),
      pagePaths: c.pagePaths.join("\n"),
      createdAt: undefined,
      updatedAt: undefined,
    },
    emailProvider: (process.env.EMAIL_PROVIDER || "log").toLowerCase(),
  };
};

type ActionResult =
  | { intent: "save"; ok: true; warning?: string }
  | { intent: "save"; ok: false; errors: Record<string, string> }
  | { intent: "test-email"; ok: boolean; message: string };

export const action = async ({ request, params }: ActionFunctionArgs): Promise<ActionResult | Response> => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "save");

  const existing = await db.campaign.findFirst({ where: { id: params.id, shop } });
  if (!existing) throw new Response("Campaign not found", { status: 404 });

  if (intent === "delete") {
    await db.campaign.delete({ where: { id: existing.id } });
    return redirect("/app/popup");
  }

  if (intent === "test-email") {
    const to = normalizeEmail(form.get("to"));
    if (!isValidEmail(to)) return { intent, ok: false, message: "Enter a valid email address." };
    if (!rateLimit(`test-email:${shop}`, 5, 10 * 60_000).allowed) {
      return { intent, ok: false, message: "Too many test emails. Try again in a few minutes." };
    }
    try {
      const info = await createShopifyGateway().getShopInfo(shop);
      await createMailer().sendDiscountEmail({
        to,
        campaign: existing,
        vars: {
          discount_code: existing.discountMode === "SHARED" ? existing.sharedCode || "WELCOME10" : `${existing.codePrefix}-TEST01`,
          discount_value: formatDiscountValue(existing),
          shop_url: info.url,
          shop_name: info.name,
        },
      });
      return { intent, ok: true, message: `Test email sent to ${to} (saved settings).` };
    } catch (err) {
      return { intent, ok: false, message: `Could not send: ${err instanceof Error ? err.message : "unknown error"}` };
    }
  }

  const parsed = parseCampaignForm(form);
  if (!parsed.ok) return { intent: "save", ok: false, errors: parsed.errors };

  await db.campaign.update({ where: { id: existing.id }, data: parsed.data });

  // Non-blocking sanity check: does the shared code actually exist in Shopify?
  let warning: string | undefined;
  if (parsed.data.discountMode === "SHARED") {
    try {
      if (!(await createShopifyGateway().discountCodeExists(shop, parsed.data.sharedCode))) {
        warning = `Saved, but no Shopify discount with code "${parsed.data.sharedCode}" was found. Create it in Shopify Admin → Discounts, or customers will receive a code that doesn't work.`;
      }
    } catch {
      warning = "Saved, but we couldn't verify the shared discount code with Shopify.";
    }
  }
  return { intent: "save", ok: true, warning };
};

function TemplateThumb({ id, colors }: { id: TemplateId; colors: { backgroundColor: string; textColor: string; buttonColor: string } }) {
  const bar = (w: string, h = 6, c = colors.textColor, o = 0.9) => <div style={{ width: w, height: h, background: c, opacity: o, borderRadius: 3, margin: "5px auto" }} />;
  const img = <div style={{ flex: "0 0 45%", background: "linear-gradient(135deg,#8aa4f0,#d9b36b)" }} />;
  return (
    <div aria-hidden="true" style={{ display: "flex", height: 84, borderRadius: 6, overflow: "hidden", border: "1px solid #ddd", background: colors.backgroundColor }}>
      {id !== "CLASSIC" && img}
      <div style={{ flex: 1, padding: "10px 10px" }}>
        {bar("80%", 8)}
        {id === "COUNTDOWN" && <div style={{ display: "flex", gap: 3, justifyContent: "center", margin: "4px 0" }}>{[0, 1, 2, 3].map((i) => <div key={i} style={{ width: 14, height: 11, background: "rgba(0,0,0,.15)", borderRadius: 2 }} />)}</div>}
        {bar("90%", 9, "#fff", 1)}
        {bar("90%", 9, colors.buttonColor, 1)}
        {id === "SPLIT" && bar("30%", 3, colors.textColor, 0.6)}
      </div>
    </div>
  );
}

export default function EditCampaign() {
  const { campaign: c, emailProvider, discounts } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const saveErrors = result && result.intent === "save" && !result.ok ? result.errors : {};
  const err = (k: string) => saveErrors[k];

  const [template, setTemplate] = useState<TemplateId>(c.template);
  const [colors, setColors] = useState({
    backgroundColor: c.backgroundColor,
    textColor: c.textColor,
    buttonColor: c.buttonColor,
    buttonTextColor: c.buttonTextColor,
  });
  const [subtitle, setSubtitle] = useState(c.subtitle);
  const [declineText, setDeclineText] = useState(c.declineText);
  const [showCountdown, setShowCountdown] = useState(c.showCountdown);
  const activeTemplate = TEMPLATES.find((t) => t.id === template)!;
  // Picking a template swaps in its colour scheme and fills template-specific defaults
  // (merchant text already typed is never overwritten).
  const pickTemplate = (id: TemplateId) => {
    const t = TEMPLATES.find((x) => x.id === id)!;
    setTemplate(id);
    setColors(t.colors);
    if (!subtitle && t.defaults.subtitle) setSubtitle(t.defaults.subtitle);
    if (!declineText && t.defaults.declineText) setDeclineText(t.defaults.declineText);
    if (t.defaults.showCountdown !== undefined) setShowCountdown(t.defaults.showCountdown);
  };
  const [sharedCode, setSharedCode] = useState(c.sharedCode);
  const picked = discounts?.find((d) => d.code.toLowerCase() === sharedCode.trim().toLowerCase());
  const [mode, setMode] = useState(c.discountMode);
  const [type, setType] = useState(c.discountType);
  const [pageTarget, setPageTarget] = useState(c.pageTarget);
  const [frequency, setFrequency] = useState(c.frequency);
  const [trigger, setTrigger] = useState(c.triggerMode);
  const [testTo, setTestTo] = useState("");
  const testFetcher = useFetcher<typeof action>();
  const testResult = testFetcher.data && testFetcher.data.intent === "test-email" ? testFetcher.data : null;

  return (
    <s-page heading={c.name} back-action-url="/app/popup">
      {result?.intent === "save" && result.ok && (
        <s-banner tone={result.warning ? "warning" : "success"} heading={result.warning ? "Saved with a warning" : "Campaign saved"}>
          {result.warning}
        </s-banner>
      )}
      {result?.intent === "save" && !result.ok && (
        <s-banner tone="critical" heading="Fix the highlighted fields and save again" />
      )}

      <PopupSubnav active="campaigns" />

      <Form method="post" data-save-bar>
        <input type="hidden" name="intent" value="save" />

        <s-section heading="Template">
          <input type="hidden" name="template" value={template} />
          <div role="radiogroup" aria-label="Popup template" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12 }}>
            {TEMPLATES.map((t) => {
              const selected = t.id === template;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  onClick={() => pickTemplate(t.id)}
                  style={{
                    textAlign: "left", cursor: "pointer", padding: 10, borderRadius: 10, background: "transparent", color: "inherit", font: "inherit",
                    border: selected ? "2px solid #005bd3" : "1px solid #c9cccf",
                  }}
                >
                  <TemplateThumb id={t.id} colors={t.colors} />
                  <div style={{ fontWeight: 600, marginTop: 8 }}>{t.label}{selected ? " ✓" : ""}</div>
                  <div style={{ fontSize: 13, opacity: 0.75 }}>{t.blurb}</div>
                </button>
              );
            })}
          </div>
          {activeTemplate.usesImage && (
            <s-paragraph color="subdued">This template looks best with an image — add one under Appearance.</s-paragraph>
          )}
        </s-section>

        <s-section heading="Campaign">
          <s-stack gap="base">
            <s-text-field label="Campaign name (internal)" name="name" value={c.name} error={err("name")} />
            <s-checkbox label="Active (show the popup on the storefront)" name="active" checked={c.active} />
          </s-stack>
        </s-section>

        <s-section heading="Popup content">
          <s-stack gap="base">
            <s-text-field label="Title" name="title" value={c.title} error={err("title")} />
            <div hidden={template !== "COUNTDOWN"}>
              <s-text-field label="Subtitle (e.g. LIMITED TIME OFFER)" name="subtitle" value={subtitle} onInput={(e) => setSubtitle(e.currentTarget.value)} />
            </div>
            <s-text-area label="Description" name="description" value={c.description} rows={3} error={err("description")} />
            <s-text-field label="Email field placeholder" name="emailPlaceholder" value={c.emailPlaceholder} />
            <s-text-field label="Button text" name="buttonText" value={c.buttonText} error={err("buttonText")} />
            <s-text-field label="Small print (optional)" name="privacyNote" value={c.privacyNote} details="Shown under the button, e.g. a privacy-policy note." />
            <s-text-field label="Success message" name="successMessage" value={c.successMessage} error={err("successMessage")} />
            <s-text-field label="Already-claimed message" name="alreadyClaimedMessage" value={c.alreadyClaimedMessage} error={err("alreadyClaimedMessage")} />
            <s-text-field label="Not-eligible message (existing customers)" name="notEligibleMessage" value={c.notEligibleMessage} error={err("notEligibleMessage")} />
            <s-text-field label="Error message" name="errorMessage" value={c.errorMessage} error={err("errorMessage")} />
          </s-stack>
        </s-section>

        <s-section heading="Appearance">
          <s-grid gridTemplateColumns="repeat(auto-fit, minmax(180px, 1fr))" gap="base">
            <s-color-field label="Background" name="backgroundColor" value={colors.backgroundColor} onChange={(e) => setColors((o) => ({ ...o, backgroundColor: e.currentTarget.value }))} error={err("backgroundColor")} />
            <s-color-field label="Text" name="textColor" value={colors.textColor} onChange={(e) => setColors((o) => ({ ...o, textColor: e.currentTarget.value }))} error={err("textColor")} />
            <s-color-field label="Button" name="buttonColor" value={colors.buttonColor} onChange={(e) => setColors((o) => ({ ...o, buttonColor: e.currentTarget.value }))} error={err("buttonColor")} />
            <s-color-field label="Button text" name="buttonTextColor" value={colors.buttonTextColor} onChange={(e) => setColors((o) => ({ ...o, buttonTextColor: e.currentTarget.value }))} error={err("buttonTextColor")} />
          </s-grid>
          <s-text-field label="Image URL (optional, https)" name="imageUrl" value={c.imageUrl} error={err("imageUrl")} details="Shown on the left on desktop and as a banner on mobile (Split / Countdown templates). Upload to Shopify Files and paste the URL." />
          <s-text-field label={'"No, thanks" link text (blank = hidden)'} name="declineText" value={declineText} onInput={(e) => setDeclineText(e.currentTarget.value)} />
          <s-checkbox label="Show countdown timer" name="showCountdown" checked={showCountdown} onChange={(e) => setShowCountdown(e.currentTarget.checked)} />
          <s-number-field label="Countdown length (hours, per visitor from first view)" name="countdownHours" value={String(c.countdownHours)} min={1} max={720} />
        </s-section>

        <s-section heading="Discount">
          <s-stack gap="base">
            <s-select label="Discount code mode" name="discountMode" value={mode} onChange={(e) => setMode(e.currentTarget.value as typeof mode)}>
              <s-option value="SHARED">Shared code (one existing Shopify discount, e.g. WELCOME10)</s-option>
              <s-option value="UNIQUE">Unique code per customer (created via Shopify API)</s-option>
            </s-select>

            <div hidden={mode !== "SHARED"}>
              <s-stack gap="base">
                {discounts && discounts.length > 0 && (
                  <s-select
                    label="Choose from your Shopify discounts"
                    value={picked?.code ?? ""}
                    onChange={(e) => {
                      const d = discounts.find((x) => x.code === e.currentTarget.value);
                      if (d) setSharedCode(d.code);
                    }}
                  >
                    <s-option value="">Select a discount…</s-option>
                    {discounts.map((d) => (
                      <s-option key={d.code} value={d.code}>{`${d.code} — ${d.summary}${d.customerRestricted ? " · specific customers" : ""}`}</s-option>
                    ))}
                  </s-select>
                )}
                <s-text-field label="Shopify discount code" name="sharedCode" value={sharedCode} onInput={(e) => setSharedCode(e.currentTarget.value)} error={err("sharedCode")}
                  details="Pick one above or type a code. It must already exist in Shopify Admin → Discounts." />
                {picked && !picked.customerRestricted && c.firstOrderOnly && (
                  <s-banner tone="warning">
                    {picked.code} isn&apos;t limited to specific customers in Shopify, so returning customers could use it at checkout. The app blocks known returning customers from claiming, but the code can be shared. To enforce first-order-only in Shopify, set this discount&apos;s customer eligibility to a segment with 0 orders.
                  </s-banner>
                )}
                {discounts === null && <s-paragraph color="subdued">Couldn&apos;t load your Shopify discounts; type the code instead.</s-paragraph>}
              </s-stack>
            </div>
            <div hidden={mode !== "UNIQUE"}>
              <s-stack gap="base">
                <s-text-field label="Code prefix" name="codePrefix" value={c.codePrefix} details="Codes look like PREFIX-X7K92A." />
                <s-number-field label="Expires after (days, blank = never)" name="expiryDays" value={c.expiryDays == null ? "" : String(c.expiryDays)} min={1} error={err("expiryDays")} />
                <s-checkbox label="One use per customer" name="oncePerCustomer" checked={c.oncePerCustomer} />
              </s-stack>
            </div>

            <s-select label="Discount type" name="discountType" value={type} onChange={(e) => setType(e.currentTarget.value as typeof type)}>
              <s-option value="PERCENTAGE">Percentage</s-option>
              <s-option value="FIXED">Fixed amount</s-option>
            </s-select>
            <s-number-field label={type === "PERCENTAGE" ? "Percentage off" : "Amount off (shop currency)"} name="discountValue" value={String(c.discountValue)} min={0} error={err("discountValue")}
              details={mode === "SHARED" ? "Display only for shared codes — the real value comes from the Shopify discount." : undefined} />
            <s-checkbox label="First order only (block customers who already have orders)" name="firstOrderOnly" checked={c.firstOrderOnly} />
          </s-stack>
        </s-section>

        <s-section heading="Shopify customer">
          <s-stack gap="base">
            <s-checkbox label="Create a Shopify customer for new emails" name="createCustomer" checked={c.createCustomer} details="Always on for unique codes (the code is bound to the customer)." />
            <s-checkbox label="Tag the customer" name="tagCustomer" checked={c.tagCustomer} />
            <s-text-field label="Tag" name="customerTag" value={c.customerTag} />
          </s-stack>
        </s-section>

        <s-section heading="Display rules">
          <s-stack gap="base">
            <s-select label="Trigger" name="triggerMode" value={trigger} onChange={(e) => setTrigger(e.currentTarget.value as typeof trigger)}>
              <s-option value="DELAY">After a delay (0 = immediately)</s-option>
              <s-option value="EXIT_INTENT">Exit intent (desktop; mobile uses the delay)</s-option>
            </s-select>
            <s-number-field label="Delay (seconds)" name="delaySeconds" value={String(c.delaySeconds)} min={0} max={300} error={err("delaySeconds")} />
            <s-select label="Show from page view" name="minPageViews" value={String(c.minPageViews)}>
              <s-option value="1">1st page view</s-option>
              <s-option value="2">2nd page view</s-option>
              <s-option value="3">3rd page view</s-option>
              <s-option value="5">5th page view</s-option>
            </s-select>
            <s-select label="Frequency" name="frequency" value={frequency} onChange={(e) => setFrequency(e.currentTarget.value as typeof frequency)}>
              <s-option value="EVERY_PAGE_LOAD">Every page load</s-option>
              <s-option value="EVERY_REFRESH">Every refresh (first view + each reload)</s-option>
              <s-option value="ONCE_PER_SESSION">Once per session</s-option>
              <s-option value="ONCE_EVERY_X_DAYS">Once every X days</s-option>
              <s-option value="UNTIL_CLAIMED">Show until claimed</s-option>
            </s-select>
            <div hidden={frequency !== "ONCE_EVERY_X_DAYS"}>
              <s-number-field label="Days between showings" name="frequencyDays" value={String(c.frequencyDays)} min={1} error={err("frequencyDays")} />
            </div>
            <s-checkbox label="Stop showing after a successful claim" name="stopAfterClaim" checked={c.stopAfterClaim}
              details="If off, the popup can reappear (e.g. on every refresh); the server still rejects a second claim." />
            <s-select label="Devices" name="deviceTarget" value={c.deviceTarget}>
              <s-option value="ALL">All devices</s-option>
              <s-option value="DESKTOP">Desktop only</s-option>
              <s-option value="MOBILE">Mobile only</s-option>
            </s-select>
            <s-select label="Pages" name="pageTarget" value={pageTarget} onChange={(e) => setPageTarget(e.currentTarget.value as typeof pageTarget)}>
              <s-option value="ALL">All pages</s-option>
              <s-option value="SELECTED">Selected pages only</s-option>
            </s-select>
            <div hidden={pageTarget !== "SELECTED"}>
              <s-text-area label="Page paths (one per line)" name="pagePaths" value={c.pagePaths} rows={4} error={err("pagePaths")}
                details="e.g. / for the home page, /collections/*, /products/my-product" />
            </div>
          </s-stack>
        </s-section>

        <s-section heading="Email">
          <s-stack gap="base">
            <s-banner tone="info">
              Provider: <strong>{emailProvider}</strong> (set EMAIL_PROVIDER on the server). Variables: {"{{ discount_code }}"}, {"{{ discount_value }}"}, {"{{ shop_url }}"}, {"{{ shop_name }}"}.
            </s-banner>
            <s-text-field label="Subject" name="emailSubject" value={c.emailSubject} error={err("emailSubject")} />
            <s-text-area label="Body" name="emailBody" value={c.emailBody} rows={9} error={err("emailBody")} />
            <s-text-field label="Sender name" name="emailFromName" value={c.emailFromName} details="Blank = EMAIL_FROM_NAME env var" />
            <s-text-field label="Sender address" name="emailFromAddress" value={c.emailFromAddress} error={err("emailFromAddress")} details="Must be a verified sender/domain at your email provider. Blank = EMAIL_FROM_ADDRESS env var." />
            <s-text-field label="Reply-to" name="emailReplyTo" value={c.emailReplyTo} error={err("emailReplyTo")} />
          </s-stack>
        </s-section>
      </Form>

      {/* Outside the main form: separate request, uses the last *saved* settings. */}
      <s-section heading="Send a test email">
        <s-stack gap="base">
          <s-text-field label="Send to" value={testTo} onInput={(e) => setTestTo(e.currentTarget.value)} />
          <s-button
            onClick={() => testFetcher.submit({ intent: "test-email", to: testTo }, { method: "post" })}
            {...(testFetcher.state !== "idle" ? { loading: true } : {})}
          >
            Send test email
          </s-button>
          {testResult && <s-banner tone={testResult.ok ? "success" : "critical"}>{testResult.message}</s-banner>}
        </s-stack>
      </s-section>

      <s-section heading="Danger zone">
        <Form method="post" onSubmit={(e) => { if (!confirm("Delete this campaign and all its claims?")) e.preventDefault(); }}>
          <input type="hidden" name="intent" value="delete" />
          <s-button tone="critical" type="submit">Delete campaign</s-button>
        </Form>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

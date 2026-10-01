import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { StatType } from "@prisma/client";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { PopupSubnav } from "../components/PopupSubnav";

const TYPES: StatType[] = ["VIEW", "SUBMISSION", "CLAIM", "DUPLICATE", "EMAIL_SENT", "EMAIL_FAILED"];

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;
  const days = Math.min(365, Math.max(1, Number(new URL(request.url).searchParams.get("days")) || 30));
  const since = new Date(Date.now() - days * 86_400_000);

  const [campaigns, stats, redeemed] = await Promise.all([
    db.campaign.findMany({ where: { shop }, select: { id: true, name: true } }),
    db.campaignDailyStat.groupBy({
      by: ["campaignId", "type"],
      where: { shop, date: { gte: since } },
      _sum: { count: true },
    }),
    db.welcomeClaim.groupBy({
      by: ["campaignId"],
      where: { shop, redeemedAt: { gte: since } },
      _count: { _all: true },
    }),
  ]);

  const rows = campaigns.map((c) => {
    const v = Object.fromEntries(TYPES.map((t) => [t, 0])) as Record<StatType, number>;
    for (const s of stats) if (s.campaignId === c.id) v[s.type] = s._sum.count ?? 0;
    const redemptions = redeemed.find((r) => r.campaignId === c.id)?._count._all ?? 0;
    return { id: c.id, name: c.name, ...v, redemptions };
  });
  const total = rows.reduce(
    (a, r) => {
      for (const t of TYPES) a[t] += r[t];
      a.redemptions += r.redemptions;
      return a;
    },
    { ...Object.fromEntries(TYPES.map((t) => [t, 0])), redemptions: 0 } as Record<StatType | "redemptions", number>,
  );
  const recent = await db.welcomeClaim.findMany({
    where: { shop },
    orderBy: { claimedAt: "desc" },
    take: 20,
    select: { id: true, email: true, status: true, claimedAt: true, redeemedAt: true },
  });
  return {
    days,
    rows,
    total,
    recent: recent.map((r) => ({ ...r, claimedAt: r.claimedAt.toISOString(), redeemedAt: r.redeemedAt?.toISOString() ?? null })),
  };
};

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

export default function Analytics() {
  const { days, rows, total, recent } = useLoaderData<typeof loader>();
  const metrics: [string, string | number][] = [
    ["Popup views", total.VIEW],
    ["Submissions", total.SUBMISSION],
    ["Successful claims", total.CLAIM],
    ["Duplicate attempts", total.DUPLICATE],
    ["Emails sent", total.EMAIL_SENT],
    ["Email failures", total.EMAIL_FAILED],
    ["Discount redemptions", total.redemptions],
    ["Conversion (claims / views)", pct(total.CLAIM, total.VIEW)],
  ];

  return (
    <s-page heading="Popup" back-action-url="/app">
      <PopupSubnav active="analytics" />
      <s-section heading={`Last ${days} days`}>
        <s-stack direction="inline" gap="small">
          {[7, 30, 90].map((d) => (
            <s-link key={d} href={`/app/popup/analytics?days=${d}`}>{d} days</s-link>
          ))}
        </s-stack>
        <s-grid gridTemplateColumns="repeat(auto-fit, minmax(170px, 1fr))" gap="base">
          {metrics.map(([label, value]) => (
            <s-box key={label} padding="base" borderWidth="base" borderRadius="base">
              <s-text color="subdued">{label}</s-text>
              <s-heading>{value}</s-heading>
            </s-box>
          ))}
        </s-grid>
        <s-paragraph color="subdued">
          Redemptions come from the orders/create webhook. Conversion counts successful claims, so repeat
          or failed submissions don&apos;t inflate it.
        </s-paragraph>
      </s-section>

      <s-section heading="By campaign">
        <s-table>
          <s-table-header-row>
            <s-table-header>Campaign</s-table-header>
            <s-table-header>Views</s-table-header>
            <s-table-header>Submissions</s-table-header>
            <s-table-header>Claims</s-table-header>
            <s-table-header>Duplicates</s-table-header>
            <s-table-header>Emails sent</s-table-header>
            <s-table-header>Redeemed</s-table-header>
            <s-table-header>Conversion</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {rows.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>{r.name}</s-table-cell>
                <s-table-cell>{r.VIEW}</s-table-cell>
                <s-table-cell>{r.SUBMISSION}</s-table-cell>
                <s-table-cell>{r.CLAIM}</s-table-cell>
                <s-table-cell>{r.DUPLICATE}</s-table-cell>
                <s-table-cell>{r.EMAIL_SENT}</s-table-cell>
                <s-table-cell>{r.redemptions}</s-table-cell>
                <s-table-cell>{pct(r.CLAIM, r.VIEW)}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>

      <s-section heading="Recent claims">
        <s-table>
          <s-table-header-row>
            <s-table-header>Email</s-table-header>
            <s-table-header>Status</s-table-header>
            <s-table-header>Claimed</s-table-header>
            <s-table-header>Redeemed</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {recent.map((r) => (
              <s-table-row key={r.id}>
                <s-table-cell>{r.email}</s-table-cell>
                <s-table-cell>{r.status}</s-table-cell>
                <s-table-cell>{new Date(r.claimedAt).toLocaleString()}</s-table-cell>
                <s-table-cell>{r.redeemedAt ? new Date(r.redeemedAt).toLocaleDateString() : "—"}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

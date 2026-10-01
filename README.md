# Trekiva Welcome Popup

Shopify app: a popup that emails a **first-order 10% discount** to a customer who submits their
email. One claim per email per campaign is enforced **in the database**; the code is **emailed,
never returned to the browser**.

Stack: React Router (Shopify's current app template) · TypeScript · Admin GraphQL API (2026-07) ·
Theme App Extension (app embed) · PostgreSQL · Prisma.

## Templates

Pick one per campaign in **Trekiva App → Popup → campaign → Template**: *Classic* (centred card),
*Split image* (image left, dark form right, "No, thanks" link) and *Countdown offer* (image,
"LIMITED TIME OFFER" line, per-visitor countdown). Choosing one swaps in its colour scheme; every
colour, text and the image stay editable. The code is never shown inside any template — it is
emailed. To add a template: add it to `PopupTemplate` (schema + migration), `app/lib/templates.ts`,
the zod enum in `campaign-form.server.ts`, and a `.twp--<name>` block in `welcome-popup.css`.

Admin menu: **Trekiva App** → Home, **Popup** (Campaigns · Analytics · Setup). New tools get a
`/app/<tool>` route tree and one `<s-link>` in `app/routes/app.tsx`.

## Flow

```
New email  -> POST claim -> INSERT claim (unique shop+campaign+email) -> find/create customer (+tag)
           -> shared code | create single-use discount -> email code -> "on its way!"
Same email -> INSERT hits the unique constraint -> no discount, no email -> "already claimed"
```

Duplicate protection is the `@@unique([shop, campaignId, email])` constraint on `WelcomeClaim`.
Concurrent requests race on the INSERT; exactly one wins. A claim that failed *after* the insert
(email provider down, Shopify error) is `EMAIL_FAILED`/`FAILED` and can be resumed (atomic
compare-and-set, max 5 attempts) **reusing the already-created discount** — so a retry never makes
a second code or a second email.

## File structure

```
prisma/schema.prisma, migrations/        Session, Campaign, WelcomeClaim, CampaignDailyStat
shopify.app.toml                         scopes, webhooks, app proxy
app/lib/
  claims.server.ts                       the claim flow (the core logic)
  public-api.server.ts                   claim / config / view endpoints (validation, rate limit, token)
  shopify-gateway.server.ts              customer + discount GraphQL (behind an interface for tests)
  email/{providers,mailer,template}      Resend | Postmark | SendGrid | SMTP | log
  bot-token.server.ts, rate-limit.server.ts, public-http.server.ts, stats.server.ts
  campaign-form.server.ts, email-address.ts, discount-code.ts
app/routes/
  app._index.tsx                         "Trekiva App" home (one card per tool)
  app.popup._index.tsx                   Popup > Campaigns list + create
  app.popup.campaigns.$id.tsx            template picker, content, discount, display rules, email, test email
  app.popup.analytics.tsx, app.popup.setup.tsx
components/PopupSubnav.tsx               Campaigns | Analytics | Setup switcher
  api.public.welcome-{claim,config,event}.tsx   public endpoints
  webhooks.{app.uninstalled,orders.create,compliance}.tsx
extensions/welcome-popup/                theme app extension (app embed)
  blocks/welcome-popup.liquid, assets/welcome-popup.{js,css}, locales/
lib/templates.ts                         template presets (colours, defaults)
tests/                                   58 tests (real Postgres)
```

## Environment variables

See `.env.example`. Required: `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES`,
`DATABASE_URL`, `CLAIM_TOKEN_SECRET` (random 32+ bytes), `EMAIL_PROVIDER`, `EMAIL_FROM_ADDRESS`
plus the key for your provider (`RESEND_API_KEY` | `POSTMARK_SERVER_TOKEN` | `SENDGRID_API_KEY` |
`SMTP_*`). `EMAIL_PROVIDER=log` only prints emails — fine for development, **no customer gets
anything**.

## Scopes

`read_customers, write_customers, read_discounts, write_discounts, read_orders`
(`read_orders` is only for the `orders/create` redemption webhook; drop it and that webhook if you
don't need redemption analytics. On a public app it requires protected-customer-data approval.)

## Webhooks

`app/uninstalled` (delete sessions, deactivate campaigns) · `app/scopes_update` ·
`orders/create` (record redemptions) · `customers/data_request`, `customers/redact`,
`shop/redact` (→ `/webhooks/compliance`). All verified via `authenticate.webhook`.

## Setup

```bash
nvm use 22                       # Node >= 22.12 (or 20.19)
npm install
docker compose up -d db          # local Postgres  (or point DATABASE_URL at your own)
cp .env.example .env             # then fill it in
npm run config:link              # link/create the app in the Partner Dashboard (fills client_id)
npm run setup                    # prisma generate + migrate deploy
npm run dev                      # shopify app dev: tunnel, installs on your dev store
```

`shopify.app.toml` has placeholder URLs (`https://example.com`); `shopify app dev` rewrites them
(including the app-proxy URL). On deploy, set them to your production URL and run `npm run deploy`.
Production: `npm run build` then `npm run docker-start` (runs migrations, then serves).

## Enable the app embed

Admin → Online Store → Themes → Customize → **App embeds** (left sidebar, plug icon) → turn on
**Welcome popup** → Save. Shortcut: the "Open theme editor" button on the app's home/Setup page.
In the theme editor the popup is forced open for preview.

## Create the WELCOME10 campaign

1. **Shopify Admin → Discounts → Create → Amount off products/order.** Code `WELCOME10`, 10%,
   *Customer eligibility → Specific customer segments →* a segment with `number_of_orders = 0`
   (this is what makes a shared code first-order-only at checkout), *Limit to one use per customer*.
2. In the app: **Create campaign** (defaults already match: title "Get 10% Off Your First Order",
   button "Get 10% Off", shared code `WELCOME10`, first-order-only, tag `welcome10_claimed`).
3. **Email** section: set sender, **Send test email**, then tick **Active** and Save.
   (Saving warns if the shared code doesn't exist in Shopify.)

For **unique codes** switch *Discount code mode* to "Unique code per customer": every claim creates
`PREFIX-X7K92A` via `discountCodeBasicCreate`, 1 total use, bound to that customer, with your expiry.

## Test duplicate protection / the storefront flow

- Automated: `npm test` (spins up an embedded Postgres; no Docker needed. Set `TEST_DATABASE_URL`
  to use your own).
- Manual: open `https://<store>/?twp_preview=<campaignId>` (forces the popup, ignoring rules).
  1. Submit `you+t1@gmail.com` → success message; email arrives; row in DB / Analytics "Recent claims".
  2. Submit `  YOU+T1@GMAIL.COM ` → "already claimed"; **no second email**, no second row.
  3. Refresh with *Every refresh* on and *Stop after claim* off → popup returns, still "already claimed".
  4. Fire it directly:
     ```bash
     for i in $(seq 20); do curl -s -XPOST "https://<store>/apps/welcome-popup/welcome-claim" \
       -H 'content-type: application/json' -d '{"campaignId":"…","email":"race@example.com","token":"<from welcome-config>"}' & done; wait
     ```
     (tokens must be ≥2 s old) → exactly one `success`.
- Checking a first-order block: claim with the email of an existing customer who has orders → "only available on a first order".

## Security notes

- **Public endpoints** (`/api/public/welcome-{claim,config,event}`) are reached through the Shopify
  **app proxy** (`/apps/welcome-popup/...`): same-origin, HMAC-signed by Shopify, shop verified.
  Direct calls also work (CORS limited to `*.myshopify.com`) but then the shop comes from the
  request and must be an installed shop.
- Anti-bot: honeypot field, signed form token (≥2 s, ≤6 h, bound to shop+campaign), per-IP and
  per-email rate limits, zod validation, 4 KB body cap. Rate limits are **in-memory per instance** —
  use a shared store (Redis) if you run several instances. They are defence in depth; uniqueness
  does not depend on them.
- Admin routes use App Bridge session tokens (no cookies), which is why there is no separate CSRF
  token. The Admin API token never leaves the server.
- Merchant text is rendered with `textContent` on the storefront and HTML-escaped in emails.
- Known trade-off: `not_eligible` reveals that an email belongs to an existing customer with orders.
  If that concerns you, change `claims.server.ts` to answer with the success message instead.

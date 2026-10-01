const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export function isShopDomain(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && SHOP_RE.test(value);
}

export function clientIp(request: Request): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return request.headers.get("x-real-ip") ?? "unknown";
}

/**
 * CORS for the direct (non app-proxy) endpoints. Only Shopify storefront
 * origins are echoed back; the default storefront script uses the same-origin
 * app proxy and never needs CORS.
 */
export function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = { Vary: "Origin" };
  if (origin) {
    try {
      const host = new URL(origin).hostname;
      if (host.endsWith(".myshopify.com")) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
        headers["Access-Control-Allow-Headers"] = "Content-Type";
        headers["Access-Control-Max-Age"] = "86400";
      }
    } catch {
      /* ignore malformed origin */
    }
  }
  return headers;
}

export function json(
  request: Request,
  body: unknown,
  status = 200,
  extra: Record<string, string> = {},
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...corsHeaders(request),
      ...extra,
    },
  });
}

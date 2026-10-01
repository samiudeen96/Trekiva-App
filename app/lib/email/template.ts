export type EmailVars = {
  discount_code: string;
  discount_value: string;
  shop_url: string;
  shop_name: string;
};

const VAR_RE = /\{\{\s*(\w+)\s*\}\}/g;

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fill(template: string, vars: Record<string, string>, esc: (s: string) => string) {
  return template.replace(VAR_RE, (_m, key: string) => (key in vars ? esc(vars[key]) : ""));
}

export function renderText(template: string, vars: EmailVars): string {
  return fill(template, vars, (s) => s);
}

/** Subject: single line, no header injection. */
export function renderSubject(template: string, vars: EmailVars): string {
  return renderText(template, vars).replace(/[\r\n]+/g, " ").trim().slice(0, 200);
}

const URL_RE = /(https?:\/\/[^\s<]+)/g;

/** Plain-text body -> simple, safe, responsive HTML. Variables are HTML-escaped. */
export function renderHtml(template: string, vars: EmailVars): string {
  const codeHtml = `<span style="display:inline-block;padding:12px 20px;border:2px dashed #1a1a1a;border-radius:6px;font-size:22px;font-weight:700;letter-spacing:2px;font-family:Menlo,Consolas,monospace">${escapeHtml(vars.discount_code)}</span>`;
  const paragraphs = template
    .split(/\n{2,}/)
    .map((block) => {
      const trimmed = block.trim();
      if (!trimmed) return "";
      // A block that is only the code variable gets the styled coupon box.
      if (/^\{\{\s*discount_code\s*\}\}$/.test(trimmed)) {
        return `<p style="margin:20px 0;text-align:center">${codeHtml}</p>`;
      }
      const html = fill(trimmed, vars, escapeHtml)
        .replace(URL_RE, (u) => `<a href="${u}" style="color:#1a1a1a">${u}</a>`)
        .replace(/\n/g, "<br>");
      return `<p style="margin:0 0 16px">${html}</p>`;
    })
    .join("");
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f5f5f5"><div style="max-width:560px;margin:0 auto;padding:32px;background:#fff;border-radius:8px;font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a">${paragraphs}</div></body></html>`;
}

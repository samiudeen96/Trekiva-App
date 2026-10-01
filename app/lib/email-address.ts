/** Trim + lowercase. The only form of an email that is ever stored or compared. */
export function normalizeEmail(raw: unknown): string {
  return typeof raw === "string" ? raw.normalize("NFKC").trim().toLowerCase() : "";
}

// Pragmatic check (not full RFC 5322): one @, dotted domain, no whitespace/control chars.
const EMAIL_RE =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function isValidEmail(email: string): boolean {
  if (email.length < 6 || email.length > 254) return false;
  const [local] = email.split("@");
  if (!local || local.length > 64) return false;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return EMAIL_RE.test(email);
}

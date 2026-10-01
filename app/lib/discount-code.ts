import { randomInt } from "node:crypto";

// No 0/O/1/I/L to keep codes easy to read and type.
const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function sanitizePrefix(prefix: string): string {
  return prefix.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "WELCOME";
}

/** e.g. WELCOME10-X7K92A (cryptographically random suffix). */
export function generateUniqueCode(prefix: string, length = 6): string {
  let suffix = "";
  for (let i = 0; i < length; i++) suffix += ALPHABET[randomInt(ALPHABET.length)];
  return `${sanitizePrefix(prefix)}-${suffix}`;
}

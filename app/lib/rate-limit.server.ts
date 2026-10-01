/**
 * Fixed-window in-memory rate limiter.
 *
 * Good enough for a single instance and as a first line of defence. If you run
 * multiple instances, swap `store` for a shared backend (Redis) behind the same
 * `rateLimit` signature. Duplicate-claim protection does NOT depend on this —
 * that is enforced by the database unique constraint.
 */
type Entry = { count: number; resetAt: number };
const store = new Map<string, Entry>();
const MAX_KEYS = 50_000;

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()) {
  if (store.size > MAX_KEYS) {
    for (const [k, v] of store) if (v.resetAt <= now) store.delete(k);
    if (store.size > MAX_KEYS) store.clear();
  }
  const entry = store.get(key);
  if (!entry || entry.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, retryAfterSec: 0 };
  }
  entry.count += 1;
  if (entry.count > limit) {
    return { allowed: false, retryAfterSec: Math.ceil((entry.resetAt - now) / 1000) };
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function resetRateLimits() {
  store.clear();
}

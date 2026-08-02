/**
 * Token-bucket rate limiter, keyed by bearer-token (or ip on unauth routes).
 *
 * Default: 60 requests / minute / token. Each `try()` either consumes a
 * token and returns `{ ok: true }` or reports remaining wait in ms.
 *
 * Refill is continuous: at `try()` time we compute how many tokens have
 * been earned since the last call (rate-limited at `capacity`) and add.
 */
export interface RateLimiterOptions {
  /** Tokens per minute. Defaults to 60. */
  rpm?: number;
  /** Bucket capacity. Defaults to `rpm` (= 1-minute burst). */
  burst?: number;
  /** Injected clock for tests. */
  now?: () => number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class RateLimiter {
  private rpm: number;
  private burst: number;
  private clock: () => number;
  private buckets = new Map<string, Bucket>();

  constructor(opts: RateLimiterOptions = {}) {
    this.rpm = opts.rpm ?? 60;
    this.burst = opts.burst ?? this.rpm;
    this.clock = opts.now ?? (() => Date.now());
  }

  try(key: string): { ok: true } | { ok: false; retryAfterMs: number } {
    const now = this.clock();
    const b = this.buckets.get(key) ?? { tokens: this.burst, lastRefillMs: now };
    // Refill.
    const elapsedMs = Math.max(0, now - b.lastRefillMs);
    const refill = (elapsedMs / 60_000) * this.rpm;
    b.tokens = Math.min(this.burst, b.tokens + refill);
    b.lastRefillMs = now;
    if (b.tokens >= 1) {
      b.tokens -= 1;
      this.buckets.set(key, b);
      return { ok: true };
    }
    // How long until we have 1 token?
    const needed = 1 - b.tokens;
    const retryAfterMs = Math.ceil((needed / this.rpm) * 60_000);
    this.buckets.set(key, b);
    return { ok: false, retryAfterMs };
  }
}

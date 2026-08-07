export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAtMs: number;
}

/**
 * Minimal fixed-window rate limiter. The connector is a single-tenant, low-QPS service, so an
 * in-process limiter is sufficient and avoids taking a dependency on shared state.
 */
export class FixedWindowRateLimiter {
  private readonly buckets = new Map<string, { count: number; resetAtMs: number }>();

  public constructor(
    private readonly max: number,
    private readonly windowMs: number,
    private readonly now: () => number = () => Date.now(),
  ) {}

  public get enabled(): boolean {
    return this.max > 0;
  }

  public consume(key: string): RateLimitDecision {
    const timestamp = this.now();
    if (!this.enabled) {
      return { allowed: true, remaining: Number.POSITIVE_INFINITY, resetAtMs: timestamp };
    }

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAtMs <= timestamp) {
      const resetAtMs = timestamp + this.windowMs;
      this.buckets.set(key, { count: 1, resetAtMs });
      this.evictExpired(timestamp);
      return { allowed: true, remaining: this.max - 1, resetAtMs };
    }

    if (bucket.count >= this.max) {
      return { allowed: false, remaining: 0, resetAtMs: bucket.resetAtMs };
    }

    bucket.count += 1;
    return { allowed: true, remaining: this.max - bucket.count, resetAtMs: bucket.resetAtMs };
  }

  private evictExpired(timestamp: number): void {
    if (this.buckets.size < 1000) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAtMs <= timestamp) this.buckets.delete(key);
    }
  }
}

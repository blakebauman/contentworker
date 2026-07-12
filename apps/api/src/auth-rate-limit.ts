/**
 * Rate-limit seam for failed auth attempts. The in-process implementation
 * below serves single-node deployments; distributed runtimes (Cloudflare
 * Workers) inject a shared-state implementation (a Durable Object per client
 * key) through `AuthDeps.rateLimiter`.
 */
export interface AuthRateLimit {
  /** True when recent failures exceed the limit. */
  isBlocked(key: string): boolean | Promise<boolean>;
  /** Record a failed attempt; returns true if the limit is now exceeded. */
  recordFailure(key: string): boolean | Promise<boolean>;
  /** Reset the window (called on successful auth). */
  clear(key: string): void | Promise<void>;
}

/**
 * In-process sliding-window rate limiter for failed auth attempts.
 */
export class AuthRateLimiter implements AuthRateLimit {
  private readonly attempts = new Map<string, number[]>();

  constructor(
    private readonly maxAttempts: number,
    private readonly windowMs: number,
  ) {}

  /** True when recent failures exceed the limit. */
  isBlocked(key: string): boolean {
    return this.recent(key).length >= this.maxAttempts;
  }

  /** Record a failed attempt; returns true if the limit is now exceeded. */
  recordFailure(key: string): boolean {
    const now = Date.now();
    const recent = this.recent(key);
    recent.push(now);
    this.attempts.set(key, recent);
    return recent.length >= this.maxAttempts;
  }

  clear(key: string): void {
    this.attempts.delete(key);
  }

  private recent(key: string): number[] {
    const now = Date.now();
    const windowStart = now - this.windowMs;
    const prev = this.attempts.get(key) ?? [];
    const recent = prev.filter((t) => t > windowStart);
    this.attempts.set(key, recent);
    return recent;
  }
}

/** Client key for rate limiting — prefers X-Forwarded-For first hop. */
export function clientIp(forwardedFor: string | undefined, remoteAddr: string | undefined): string {
  const forwarded = forwardedFor?.split(',')[0]?.trim();
  return forwarded || remoteAddr || 'unknown';
}

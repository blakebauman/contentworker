import type { Redis } from 'ioredis';

/**
 * Failed-auth rate limiter shared across API replicas via Redis. Mirrors the
 * `AuthRateLimit` shape consumed by the API (a per-key fixed window). Keeping it
 * here avoids an app→adapter dependency; the API injects it through AuthDeps.
 *
 * A per-key counter is INCR'd on each failure and expires after the window, so
 * spreading attempts across pods no longer multiplies the effective budget.
 */
export interface RedisAuthRateLimiter {
  isBlocked(key: string): Promise<boolean>;
  recordFailure(key: string): Promise<boolean>;
  clear(key: string): Promise<void>;
}

export function createRedisAuthRateLimiter(
  connection: Redis,
  maxAttempts: number,
  windowMs: number,
): RedisAuthRateLimiter {
  const windowSeconds = Math.ceil(windowMs / 1000);
  const redisKey = (key: string) => `cwauth:fail:${key}`;
  return {
    async isBlocked(key) {
      const n = Number((await connection.get(redisKey(key))) ?? 0);
      return n >= maxAttempts;
    },
    async recordFailure(key) {
      const k = redisKey(key);
      const n = await connection.incr(k);
      if (n === 1) await connection.expire(k, windowSeconds);
      return n >= maxAttempts;
    },
    async clear(key) {
      await connection.del(redisKey(key));
    },
  };
}

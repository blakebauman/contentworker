import type { Scope } from '@cw/domain';
import type { AiBudgetDecision, CostGuard } from '@cw/ports';
import type { Redis } from 'ioredis';

export interface RedisCostGuardLimits {
  /** Max AI requests per scope per window. */
  readonly maxRequests: number;
  /** Max total tokens (input+output) per scope per window. */
  readonly maxTokens: number;
  /** Rolling window length in seconds. */
  readonly windowSeconds: number;
}

/**
 * Redis-backed per-tenant AI budget governor using fixed-window counters shared
 * across API/worker replicas. Two keys per space per window bucket track request
 * count and token usage; both expire when the window rolls, so no cleanup is
 * needed. Budget is per space (the tenant boundary), not per environment.
 */
export function createRedisCostGuard(
  connection: Redis,
  limits: RedisCostGuardLimits,
  opts: { keyPrefix?: string } = {},
): CostGuard {
  // Distinct prefixes give independent windows (e.g. `cwagent` for background
  // agent spend vs the default interactive window).
  const prefix = opts.keyPrefix ?? 'cwai';
  const windowMs = limits.windowSeconds * 1000;
  const bucket = () => Math.floor(Date.now() / windowMs);
  const reqKey = (scope: Scope) => `${prefix}:req:${scope.spaceId}:${bucket()}`;
  const tokKey = (scope: Scope) => `${prefix}:tok:${scope.spaceId}:${bucket()}`;
  const retryAfter = () => Math.ceil((((bucket() + 1) * windowMs - Date.now()) as number) / 1000);

  return {
    async consume(scope): Promise<AiBudgetDecision> {
      const rKey = reqKey(scope);
      const [requests, tokensRaw] = await Promise.all([
        connection.incr(rKey),
        connection.get(tokKey(scope)),
      ]);
      // Expire the counter one window out so a stale bucket self-cleans.
      if (requests === 1) await connection.expire(rKey, limits.windowSeconds + 1);
      const tokens = Number(tokensRaw ?? 0);
      if (tokens >= limits.maxTokens) {
        return { allowed: false, reason: 'tokens', retryAfterSeconds: retryAfter() };
      }
      if (requests > limits.maxRequests) {
        return { allowed: false, reason: 'requests', retryAfterSeconds: retryAfter() };
      }
      return { allowed: true };
    },
    async settle(scope, tokens): Promise<void> {
      if (tokens <= 0) return;
      const tKey = tokKey(scope);
      const total = await connection.incrby(tKey, Math.trunc(tokens));
      if (total === Math.trunc(tokens)) await connection.expire(tKey, limits.windowSeconds + 1);
    },
  };
}

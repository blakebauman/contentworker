import type { Cache, Clock, ContentStore, CostGuard, IdGenerator } from '@cw/ports';

/**
 * The dependencies every use-case needs. Built once at the composition root
 * (apps/api/src/wire.ts) by binding concrete adapters to the ports.
 */
export interface AppContext {
  readonly store: ContentStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  /** Optional delivery cache; when absent, reads go straight to the store. */
  readonly cache?: Cache;
  /**
   * TTL for delivery cache entries, seconds. A garbage-collection bound only —
   * tag-version invalidation stays the correctness mechanism — so backends
   * don't accumulate every render ever produced. Default 86400 (1 day).
   */
  readonly deliveryCacheTtlSeconds?: number;
  /**
   * TTL for cached LIST results, seconds. Shorter than the single-entry TTL:
   * lists are invalidated by coarse content-type tags, so the TTL is the
   * backstop for the cases those tags over- or under-cover. Default 3600.
   */
  readonly deliveryListTtlSeconds?: number;
  /** Optional per-tenant AI budget governor; when absent, AI calls are unmetered. */
  readonly costGuard?: CostGuard;
}

/** Default {@link AppContext.deliveryCacheTtlSeconds}. */
export const DEFAULT_DELIVERY_CACHE_TTL_SECONDS = 86_400;

/** Default {@link AppContext.deliveryListTtlSeconds}. */
export const DEFAULT_DELIVERY_LIST_TTL_SECONDS = 3_600;

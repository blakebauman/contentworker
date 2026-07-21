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
  /** Optional per-tenant AI budget governor; when absent, AI calls are unmetered. */
  readonly costGuard?: CostGuard;
}

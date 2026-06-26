/**
 * 12-factor environment configuration. Adapter selection is driven entirely by
 * env vars (set per cloud by Helm), so the same image runs anywhere.
 */
export type Role = 'all' | 'management' | 'delivery' | 'preview';

export interface ApiConfig {
  readonly role: Role;
  readonly port: number;
  /** When absent, an in-memory store is used (dev / tests / demos). */
  readonly databaseUrl?: string;
  /** When set, the Redis-backed delivery cache is used (shared with the worker). */
  readonly redisUrl?: string;
  /** Content Management API key (write access). */
  readonly cmaKey: string;
  /** Content Delivery API key (read published). */
  readonly cdaKey: string;
  /** Content Preview API key (read drafts). */
  readonly cpaKey: string;
  /** Root/admin bearer token — all scopes, all spaces (provisioning). */
  readonly adminToken: string;
  /**
   * Dev seeding. The in-memory store always seeds; with a real database this
   * gates an idempotent bootstrap (space + dev keys + a demo type) so a fresh
   * Postgres stack is usable out of the box. Never enable in production.
   */
  readonly seedDev: boolean;
  /** Default space/env + locales used to seed the in-memory store. */
  readonly seed: {
    spaceId: string;
    environmentId: string;
    defaultLocale: string;
    locales: string[];
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const role = (env.ROLE ?? 'all') as Role;
  if (!['all', 'management', 'delivery', 'preview'].includes(role)) {
    throw new Error(`Invalid ROLE "${role}"`);
  }
  return {
    role,
    port: Number(env.PORT ?? 8787),
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    cmaKey: env.CMA_KEY ?? 'dev-cma-key',
    cdaKey: env.CDA_KEY ?? 'dev-cda-key',
    cpaKey: env.CPA_KEY ?? 'dev-cpa-key',
    adminToken: env.ADMIN_TOKEN ?? 'dev-admin-token',
    seedDev: env.SEED_DEV === 'true',
    seed: {
      spaceId: env.SEED_SPACE_ID ?? 'space-1',
      environmentId: env.SEED_ENV_ID ?? 'main',
      defaultLocale: env.SEED_DEFAULT_LOCALE ?? 'en-US',
      locales: (env.SEED_LOCALES ?? 'en-US').split(',').map((s) => s.trim()),
    },
  };
}

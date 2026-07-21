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
  /** Optional server-side pepper mixed into API key hashes at rest. */
  readonly tokenPepper?: string;
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
  /** HMAC secret for admin SSO session cookies. */
  readonly sessionSecret: string;
  readonly sessionTtlHours: number;
  /** Post-login redirect for OIDC (admin SPA URL). */
  readonly adminUiUrl: string;
  readonly oidcDefaultSpace: string;
  readonly oidcIssuer?: string;
  readonly oidcClientId?: string;
  readonly oidcClientSecret?: string;
  readonly oidcRedirectUri?: string;
  readonly oidcGroupRoleMap: Record<string, string>;
  /**
   * Role assigned to an OIDC-authenticated user whose IdP groups match no entry
   * in {@link oidcGroupRoleMap}. When unset, unmapped logins are refused rather
   * than falling through to a full-privilege CMA key (fail closed).
   */
  readonly oidcDefaultRole?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const role = (env.ROLE ?? 'all') as Role;
  if (!['all', 'management', 'preview', 'delivery'].includes(role)) {
    throw new Error(`Invalid ROLE "${role}"`);
  }
  let oidcGroupRoleMap: Record<string, string> = {};
  if (env.OIDC_GROUP_ROLE_MAP) {
    oidcGroupRoleMap = JSON.parse(env.OIDC_GROUP_ROLE_MAP) as Record<string, string>;
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
    tokenPepper: env.TOKEN_PEPPER,
    seedDev: env.SEED_DEV === 'true',
    seed: {
      spaceId: env.SEED_SPACE_ID ?? 'space-1',
      environmentId: env.SEED_ENV_ID ?? 'main',
      defaultLocale: env.SEED_DEFAULT_LOCALE ?? 'en-US',
      locales: (env.SEED_LOCALES ?? 'en-US').split(',').map((s) => s.trim()),
    },
    sessionSecret: env.SESSION_SECRET ?? 'dev-session-secret-change-me-in-production',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 8),
    adminUiUrl: env.ADMIN_UI_URL ?? 'http://localhost:5173/dashboard',
    oidcDefaultSpace: env.OIDC_DEFAULT_SPACE ?? env.SEED_SPACE_ID ?? 'space-1',
    oidcIssuer: env.OIDC_ISSUER,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcClientSecret: env.OIDC_CLIENT_SECRET,
    oidcRedirectUri: env.OIDC_REDIRECT_URI,
    oidcGroupRoleMap,
    oidcDefaultRole: env.OIDC_DEFAULT_ROLE,
  };
}

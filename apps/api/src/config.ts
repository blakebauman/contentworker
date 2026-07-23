/**
 * 12-factor environment configuration. Adapter selection is driven entirely by
 * env vars (set per cloud by Helm), so the same image runs anywhere.
 */
export type Role = 'all' | 'management' | 'delivery' | 'preview';

/**
 * True when this deployment mounts the given API surface. ROLE is a single
 * role or a comma-separated union (e.g. `delivery,preview` for a scale-out
 * read plane that serves drafts too); `all` mounts everything.
 */
export function mountsRole(config: Pick<ApiConfig, 'role'>, role: Exclude<Role, 'all'>): boolean {
  const roles = config.role.split(',').map((s) => s.trim());
  return roles.includes('all') || roles.includes(role);
}

export interface ApiConfig {
  /** One {@link Role}, or a comma-separated union — check via {@link mountsRole}. */
  readonly role: string;
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
   * Dev seeding. The in-memory store always seeds space + keys; SEED_DEV=true
   * additionally runs the @cw/seed demo dataset (all content types, a scaled
   * entry corpus, and every platform surface) so a fresh stack is usable out
   * of the box. Never enable in production.
   */
  readonly seedDev: boolean;
  /** Default space/env + locales used to seed the in-memory store. */
  readonly seed: {
    spaceId: string;
    environmentId: string;
    defaultLocale: string;
    locales: string[];
    /** Corpus multiplier (SEED_SCALE): 1 = demo (~550 entries), 100 = bench. */
    scale: number;
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
  /** Max accepted request body size in bytes (DoS guard). Default 5 MiB. */
  readonly maxBodyBytes?: number;
  /** Trusted reverse proxies in front (spoof-resistant X-Forwarded-For parsing). */
  readonly trustedProxyCount?: number;
  /**
   * When true, publishing an entry runs the moderation classifier first and
   * blocks the publish if the content is flagged (a synchronous pre-publish
   * gate). Off by default — moderation otherwise runs post-publish and retracts.
   */
  readonly moderateBeforePublish?: boolean;
  /**
   * Per-space AI usage ceilings over a rolling window. Guards against a single
   * tenant driving unbounded LLM spend. Set `maxRequests` or `maxTokens` to 0 to
   * disable metering entirely.
   */
  readonly aiBudget?: {
    readonly maxRequests: number;
    readonly maxTokens: number;
    readonly windowSeconds: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const role = (env.ROLE ?? 'all').trim();
  const roles = role.split(',').map((s) => s.trim());
  if (
    roles.length === 0 ||
    roles.some((r) => !['all', 'management', 'preview', 'delivery'].includes(r))
  ) {
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
      scale: Math.max(1, Math.floor(Number(env.SEED_SCALE ?? '1')) || 1),
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
    maxBodyBytes: Number(env.MAX_BODY_BYTES ?? 5 * 1024 * 1024),
    trustedProxyCount: Number(env.TRUSTED_PROXY_COUNT ?? 1),
    moderateBeforePublish: env.AGENTS_MODERATE_BLOCKING === 'true',
    aiBudget: {
      maxRequests: Number(env.AI_MAX_REQUESTS_PER_WINDOW ?? 60),
      maxTokens: Number(env.AI_MAX_TOKENS_PER_WINDOW ?? 200_000),
      windowSeconds: Number(env.AI_BUDGET_WINDOW_SECONDS ?? 60),
    },
  };
}

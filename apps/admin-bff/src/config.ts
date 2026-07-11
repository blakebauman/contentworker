export interface BffConfig {
  readonly port: number;
  readonly sessionSecret: string;
  readonly apiUrl: string;
  readonly adminToken: string;
  readonly defaultSpace: string;
  readonly sessionTtlHours: number;
  readonly oidcIssuer?: string;
  readonly oidcClientId?: string;
  readonly oidcClientSecret?: string;
  readonly oidcRedirectUri?: string;
  /** JSON map of IdP group name → role id in defaultSpace. */
  readonly oidcGroupRoleMap: Record<string, string>;
}

export function loadBffConfig(env: NodeJS.ProcessEnv = process.env): BffConfig {
  let oidcGroupRoleMap: Record<string, string> = {};
  if (env.OIDC_GROUP_ROLE_MAP) {
    oidcGroupRoleMap = JSON.parse(env.OIDC_GROUP_ROLE_MAP) as Record<string, string>;
  }
  return {
    port: Number(env.PORT ?? 8790),
    sessionSecret: env.SESSION_SECRET ?? 'dev-session-secret-change-me-in-production',
    apiUrl: (env.CW_API_URL ?? 'http://localhost:8787').replace(/\/$/, ''),
    adminToken: env.ADMIN_TOKEN ?? 'dev-admin-token',
    defaultSpace: env.OIDC_DEFAULT_SPACE ?? 'space-1',
    sessionTtlHours: Number(env.SESSION_TTL_HOURS ?? 8),
    oidcIssuer: env.OIDC_ISSUER,
    oidcClientId: env.OIDC_CLIENT_ID,
    oidcClientSecret: env.OIDC_CLIENT_SECRET,
    oidcRedirectUri: env.OIDC_REDIRECT_URI,
    oidcGroupRoleMap,
  };
}

export function oidcEnabled(config: BffConfig): boolean {
  return Boolean(
    config.oidcIssuer && config.oidcClientId && config.oidcClientSecret && config.oidcRedirectUri,
  );
}

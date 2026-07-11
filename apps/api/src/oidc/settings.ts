import type { ApiConfig } from '../config.js';

export interface OidcSettings {
  readonly sessionSecret: string;
  readonly sessionTtlHours: number;
  readonly adminUiUrl: string;
  readonly defaultSpace: string;
  readonly issuer?: string;
  readonly clientId?: string;
  readonly clientSecret?: string;
  readonly redirectUri?: string;
  readonly groupRoleMap: Record<string, string>;
}

export function oidcSettingsFromConfig(config: ApiConfig): OidcSettings {
  return {
    sessionSecret: config.sessionSecret,
    sessionTtlHours: config.sessionTtlHours,
    adminUiUrl: config.adminUiUrl,
    defaultSpace: config.oidcDefaultSpace,
    issuer: config.oidcIssuer,
    clientId: config.oidcClientId,
    clientSecret: config.oidcClientSecret,
    redirectUri: config.oidcRedirectUri,
    groupRoleMap: config.oidcGroupRoleMap,
  };
}

export function oidcEnabled(settings: OidcSettings): boolean {
  return Boolean(
    settings.issuer && settings.clientId && settings.clientSecret && settings.redirectUri,
  );
}

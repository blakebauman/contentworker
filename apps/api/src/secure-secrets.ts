import { assertSecureSecrets, requireSecureSecretsFromEnv } from '@cw/application';
import type { ApiConfig } from './config.js';

/** Validates auth secrets at API startup (production / REQUIRE_SECURE_SECRETS). */
export function validateApiSecrets(config: ApiConfig, env: NodeJS.ProcessEnv = process.env): void {
  // The session secret only signs admin SSO cookies, so it is only enforced when
  // OIDC is actually configured — non-OIDC deployments need not set it.
  const oidcEnabled = Boolean(
    config.oidcIssuer && config.oidcClientId && config.oidcClientSecret && config.oidcRedirectUri,
  );
  assertSecureSecrets({
    requireSecureSecrets: requireSecureSecretsFromEnv(env),
    seedDev: config.seedDev,
    adminToken: config.adminToken,
    cmaKey: config.cmaKey,
    cdaKey: config.cdaKey,
    cpaKey: config.cpaKey,
    sessionSecret: oidcEnabled ? config.sessionSecret : undefined,
  });
}

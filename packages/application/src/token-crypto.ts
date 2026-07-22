import { createHash, timingSafeEqual } from 'node:crypto';
import type { Hasher } from '@cw/ports';

/** Known dev defaults that must not be used when secure secrets are required. */
export const DEV_TOKEN_DEFAULTS = new Set([
  'dev-cma-key',
  'dev-cda-key',
  'dev-cpa-key',
  'dev-admin-token',
  'dev-mcp-token',
  'dev-session-secret-change-me-in-production',
]);

const MIN_SECRET_LENGTH = 32;

/** SHA-256 hasher with optional server-side pepper (defense in depth at rest). */
export function createHasher(pepper?: string): Hasher {
  const prefix = pepper ?? '';
  return {
    hash: (value: string) =>
      createHash('sha256')
        .update(prefix + value)
        .digest('hex'),
  };
}

/** Constant-time comparison for bearer secrets (admin/MCP tokens). */
export function secureTokenEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

export interface SecureSecretsInput {
  readonly requireSecureSecrets: boolean;
  readonly seedDev: boolean;
  readonly adminToken: string;
  readonly mcpToken?: string;
  readonly cmaKey?: string;
  readonly cdaKey?: string;
  readonly cpaKey?: string;
  /** HMAC secret for admin SSO session cookies; pass only when OIDC is enabled. */
  readonly sessionSecret?: string;
}

/**
 * Fail fast when production (or REQUIRE_SECURE_SECRETS) would run with known
 * weak credentials. Call at process startup in API and MCP servers.
 */
export function assertSecureSecrets(input: SecureSecretsInput): void {
  if (!input.requireSecureSecrets) return;

  const errors: string[] = [];

  if (input.seedDev) {
    errors.push('SEED_DEV must not be true when secure secrets are required');
  }

  for (const [name, value] of [
    ['ADMIN_TOKEN', input.adminToken],
    ['MCP_TOKEN', input.mcpToken],
    ['CMA_KEY', input.cmaKey],
    ['CDA_KEY', input.cdaKey],
    ['CPA_KEY', input.cpaKey],
    ['SESSION_SECRET', input.sessionSecret],
  ] as const) {
    if (!value) continue;
    if (DEV_TOKEN_DEFAULTS.has(value)) {
      errors.push(`${name} must not use a known dev default`);
    }
    if (value.length < MIN_SECRET_LENGTH) {
      errors.push(`${name} must be at least ${MIN_SECRET_LENGTH} characters`);
    }
  }

  if (input.adminToken && input.mcpToken && input.adminToken === input.mcpToken) {
    errors.push('ADMIN_TOKEN and MCP_TOKEN must differ');
  }

  if (errors.length > 0) {
    throw new Error(`Insecure configuration:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
}

export function requireSecureSecretsFromEnv(env: NodeJS.ProcessEnv): boolean {
  if (env.REQUIRE_SECURE_SECRETS === 'false') return false;
  return env.REQUIRE_SECURE_SECRETS === 'true' || env.NODE_ENV === 'production';
}

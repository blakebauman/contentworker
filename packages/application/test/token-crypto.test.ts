import { describe, expect, it } from 'vitest';
import {
  DEV_TOKEN_DEFAULTS,
  assertSecureSecrets,
  createHasher,
  requireSecureSecretsFromEnv,
  secureTokenEqual,
} from '../src/token-crypto.js';

describe('token-crypto', () => {
  it('secureTokenEqual rejects length mismatch', () => {
    expect(secureTokenEqual('abc', 'abcd')).toBe(false);
  });

  it('createHasher applies pepper', () => {
    const a = createHasher('pepper').hash('token');
    const b = createHasher().hash('token');
    expect(a).not.toBe(b);
  });

  it('assertSecureSecrets rejects dev defaults in production mode', () => {
    expect(() =>
      assertSecureSecrets({
        requireSecureSecrets: true,
        seedDev: true,
        adminToken: 'dev-admin-token',
      }),
    ).toThrow(/Insecure configuration/);
  });

  it('requireSecureSecretsFromEnv is true when NODE_ENV=production', () => {
    expect(requireSecureSecretsFromEnv({ NODE_ENV: 'production' })).toBe(true);
  });

  it('REQUIRE_SECURE_SECRETS=false overrides NODE_ENV=production', () => {
    expect(
      requireSecureSecretsFromEnv({ NODE_ENV: 'production', REQUIRE_SECURE_SECRETS: 'false' }),
    ).toBe(false);
  });

  it('lists known dev token defaults', () => {
    expect(DEV_TOKEN_DEFAULTS.has('dev-cma-key')).toBe(true);
  });
});

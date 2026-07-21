import { type AppContext, createHasher, createRole, createSpace } from '@cw/application';
import { UnauthorizedError } from '@cw/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import { mintDelegatedKey } from '../src/oidc/delegated-key.js';
import type { OidcSettings } from '../src/oidc/settings.js';

const hasher = createHasher();

function baseSettings(overrides: Partial<OidcSettings> = {}): OidcSettings {
  return {
    sessionSecret: 'x'.repeat(32),
    sessionTtlHours: 8,
    adminUiUrl: 'http://localhost/dashboard',
    defaultSpace: 's1',
    groupRoleMap: {},
    ...overrides,
  };
}

/**
 * Regression for the OIDC default-allow escalation: a successfully authenticated
 * user whose IdP groups map to no role must NOT fall through to a full-privilege
 * CMA key. Login fails closed unless a group maps or a default role is set.
 */
describe('OIDC delegated key mints fail closed', () => {
  let ctx: AppContext;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('a'),
    };
    await createSpace(ctx, { spaceId: 's1', name: 'One', defaultLocale: 'en-US' });
  });

  it('refuses login when no group maps and no default role is configured', async () => {
    await expect(
      mintDelegatedKey(ctx, hasher, baseSettings(), 'user@example.com', ['unmapped-group']),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('refuses login when the user has no groups at all', async () => {
    await expect(
      mintDelegatedKey(ctx, hasher, baseSettings(), 'user@example.com', []),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('falls back to the configured default role for unmapped users', async () => {
    const role = await createRole(ctx, 's1', { name: 'reader', scopes: ['delivery:read'] });
    const minted = await mintDelegatedKey(
      ctx,
      hasher,
      baseSettings({ defaultRole: role.id }),
      'user@example.com',
      ['unmapped-group'],
    );
    expect(minted.token).toMatch(/^cw_cma_/);
  });

  it('uses the mapped role when a group matches', async () => {
    const role = await createRole(ctx, 's1', { name: 'editor', scopes: ['content:write'] });
    const minted = await mintDelegatedKey(
      ctx,
      hasher,
      baseSettings({ groupRoleMap: { editors: role.id } }),
      'user@example.com',
      ['editors'],
    );
    expect(minted.token).toMatch(/^cw_cma_/);
  });
});

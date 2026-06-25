import { ForbiddenError, NotFoundError, SCOPES, UnauthorizedError, authorize } from '@cw/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { describe, expect, it } from 'vitest';
import { type AppContext, authenticate, createApiKey, revokeApiKey } from '../src/index.js';

// A trivial deterministic hasher for tests.
const hasher = { hash: (v: string) => `h:${v}` };

function ctx(): AppContext {
  return {
    store: new InMemoryContentStore(),
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('k'),
  };
}

describe('RBAC: API keys + authorization', () => {
  it('mints a key, stores only the hash, and authenticates the raw token', async () => {
    const c = ctx();
    const { apiKey, token } = await createApiKey(c, hasher, {
      spaceId: 's1',
      kind: 'cma',
      name: 'k',
    });
    expect(token.startsWith('cw_cma_')).toBe(true);
    // The stored value is the hasher's output, not the raw token.
    expect(apiKey.hashedToken).toBe(hasher.hash(token));

    const principal = await authenticate(c, hasher, token);
    expect(principal.spaceId).toBe('s1');
    expect(principal.kind).toBe('cma');
    expect(principal.scopes).toContain(SCOPES.contentWrite);
  });

  it('revokes a key so its token no longer authenticates', async () => {
    const c = ctx();
    const { apiKey, token } = await createApiKey(c, hasher, { spaceId: 's1', kind: 'cma' });
    await expect(authenticate(c, hasher, token)).resolves.toBeTruthy();
    await revokeApiKey(c, 's1', apiKey.id);
    await expect(authenticate(c, hasher, token)).rejects.toBeInstanceOf(UnauthorizedError);
    // Revoking a key from another space (or a missing key) is a 404.
    await expect(revokeApiKey(c, 's2', apiKey.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rejects unknown / missing tokens with UnauthorizedError', async () => {
    const c = ctx();
    await expect(authenticate(c, hasher, undefined)).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(authenticate(c, hasher, 'nope')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('authorize enforces scope and space boundaries', async () => {
    const cda = { spaceId: 's1', kind: 'cda' as const, scopes: [SCOPES.deliveryRead] };
    // Has the scope in its own space.
    expect(() => authorize(cda, SCOPES.deliveryRead, 's1')).not.toThrow();
    // Lacks the write scope.
    expect(() => authorize(cda, SCOPES.contentWrite, 's1')).toThrow(ForbiddenError);
    // Right scope, wrong space.
    expect(() => authorize(cda, SCOPES.deliveryRead, 's2')).toThrow(ForbiddenError);
    // Admin (wildcard space) may act anywhere.
    const admin = { spaceId: '*', kind: 'admin' as const, scopes: [SCOPES.contentWrite] };
    expect(() => authorize(admin, SCOPES.contentWrite, 'any-space')).not.toThrow();
  });
});

import {
  type ApiKey,
  type ApiKeyKind,
  NotFoundError,
  type Principal,
  UnauthorizedError,
  scopesForKind,
} from '@cw/domain';
import type { Hasher } from '@cw/ports';
import type { AppContext } from './context.js';
import { randomSecret } from './token-crypto.js';

export interface CreateApiKeyInput {
  readonly spaceId: string;
  readonly kind: ApiKeyKind;
  /** Optional human-readable label. */
  readonly name?: string;
  /** Overrides the default scope set for the kind. */
  readonly scopes?: readonly string[];
  /**
   * Bind the key to a custom role (granular RBAC). The role's scopes and
   * content grants are resolved live on every request, superseding `scopes`.
   */
  readonly roleId?: string;
  /** ISO timestamp after which the key stops authenticating (optional). */
  readonly expiresAt?: string;
}

export interface CreatedApiKey {
  readonly apiKey: ApiKey;
  /** The raw token — shown ONCE; only its hash is stored. */
  readonly token: string;
}

/**
 * Mints an API key: generates a high-entropy token, stores only its hash, and
 * returns the raw token once. Token shape: `cw_<kind>_<random>`.
 */
export async function createApiKey(
  ctx: AppContext,
  hasher: Hasher,
  input: CreateApiKeyInput,
): Promise<CreatedApiKey> {
  let roleScopes: readonly string[] | undefined;
  if (input.roleId) {
    const role = await ctx.store.roles.get(input.spaceId, input.roleId);
    if (!role) throw new NotFoundError('Role', input.roleId);
    roleScopes = role.scopes;
  }
  const token = `cw_${input.kind}_${randomSecret()}`;
  const apiKey: ApiKey = {
    id: ctx.ids.newId(),
    spaceId: input.spaceId,
    kind: input.kind,
    name: input.name,
    hashedToken: hasher.hash(token),
    // Stored scopes are a snapshot for display; role-bound keys resolve live.
    scopes: roleScopes ?? input.scopes ?? scopesForKind(input.kind),
    revoked: false,
    roleId: input.roleId,
    expiresAt: input.expiresAt,
  };
  await ctx.store.auth.createApiKey(apiKey);
  return { apiKey, token };
}

/** Resolves a bearer token to a Principal, or throws UnauthorizedError. */
export async function authenticate(
  ctx: AppContext,
  hasher: Hasher,
  token: string | undefined,
): Promise<Principal> {
  if (!token) throw new UnauthorizedError();
  const key = await ctx.store.auth.findByHash(hasher.hash(token));
  if (!key) throw new UnauthorizedError();
  // Expired keys fail closed (e.g. an orphaned OIDC-delegated key whose session
  // lapsed). Checked here so both stores enforce it uniformly.
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= ctx.clock.now().getTime()) {
    throw new UnauthorizedError('API key has expired');
  }
  // Best-effort last-used tracking — must not block authentication.
  void ctx.store.auth.touchLastUsed(key.id, ctx.clock.now()).catch(() => {});
  if (key.roleId) {
    // Role-bound key: the role is the live source of truth. A dangling
    // roleId (role deleted out-of-band) fails closed.
    const role = await ctx.store.roles.get(key.spaceId, key.roleId);
    if (!role) throw new UnauthorizedError('API key role no longer exists');
    return {
      spaceId: key.spaceId,
      kind: key.kind,
      scopes: role.scopes,
      contentGrants: role.contentGrants,
    };
  }
  return { spaceId: key.spaceId, kind: key.kind, scopes: key.scopes };
}

export async function listApiKeys(ctx: AppContext, spaceId: string): Promise<ApiKey[]> {
  return ctx.store.auth.list(spaceId);
}

/** Revokes a key (by id) after verifying it belongs to the space. */
export async function revokeApiKey(ctx: AppContext, spaceId: string, keyId: string): Promise<void> {
  const keys = await ctx.store.auth.list(spaceId);
  if (!keys.some((k) => k.id === keyId)) throw new NotFoundError('ApiKey', keyId);
  await ctx.store.auth.revoke(keyId);
}

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

export interface CreateApiKeyInput {
  readonly spaceId: string;
  readonly kind: ApiKeyKind;
  /** Optional human-readable label. */
  readonly name?: string;
  /** Overrides the default scope set for the kind. */
  readonly scopes?: readonly string[];
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
  const secret = (ctx.ids.newId() + ctx.ids.newId()).replace(/-/g, '');
  const token = `cw_${input.kind}_${secret}`;
  const apiKey: ApiKey = {
    id: ctx.ids.newId(),
    spaceId: input.spaceId,
    kind: input.kind,
    name: input.name,
    hashedToken: hasher.hash(token),
    scopes: input.scopes ?? scopesForKind(input.kind),
    revoked: false,
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
  return { spaceId: key.spaceId, kind: key.kind, scopes: key.scopes };
}

export async function listApiKeys(ctx: AppContext, spaceId: string): Promise<ApiKey[]> {
  return ctx.store.auth.list(spaceId);
}

/** Revokes a key (by id) after verifying it belongs to the space. */
export async function revokeApiKey(
  ctx: AppContext,
  spaceId: string,
  keyId: string,
): Promise<void> {
  const keys = await ctx.store.auth.list(spaceId);
  if (!keys.some((k) => k.id === keyId)) throw new NotFoundError('ApiKey', keyId);
  await ctx.store.auth.revoke(keyId);
}

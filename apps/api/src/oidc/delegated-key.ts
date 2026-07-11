import { createApiKey, revokeApiKey } from '@cw/application';
import type { AppContext } from '@cw/application';
import type { Hasher } from '@cw/ports';
import type { OidcSettings } from './settings.js';

export interface MintedSessionKey {
  readonly token: string;
  readonly keyId: string;
}

/** Mints a short-lived CMA key for an OIDC-authenticated admin session. */
export async function mintDelegatedKey(
  ctx: AppContext,
  hasher: Hasher,
  settings: OidcSettings,
  subject: string,
  groups: readonly string[],
): Promise<MintedSessionKey> {
  let roleId: string | undefined;
  for (const group of groups) {
    const mapped = settings.groupRoleMap[group];
    if (mapped) {
      roleId = mapped;
      break;
    }
  }

  const { apiKey, token } = await createApiKey(ctx, hasher, {
    spaceId: settings.defaultSpace,
    kind: 'cma',
    name: `oidc:${subject}`,
    roleId,
  });
  return { token, keyId: apiKey.id };
}

export async function revokeDelegatedKey(
  ctx: AppContext,
  settings: OidcSettings,
  keyId: string,
): Promise<void> {
  await revokeApiKey(ctx, settings.defaultSpace, keyId);
}

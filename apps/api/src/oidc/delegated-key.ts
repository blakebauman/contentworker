import { createApiKey, revokeApiKey } from '@cw/application';
import type { AppContext } from '@cw/application';
import { UnauthorizedError } from '@cw/domain';
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
  // Fail closed: a user whose groups map to no role falls back to the configured
  // default role, and if none is configured the login is refused. Without this,
  // createApiKey would mint an unrestricted CMA key (incl. space:admin) for any
  // successfully authenticated user — authentication must not imply admin.
  roleId ??= settings.defaultRole;
  if (!roleId) {
    throw new UnauthorizedError(
      'No role is mapped to your identity. Contact an administrator to be granted access.',
    );
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

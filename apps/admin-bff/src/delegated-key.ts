import type { BffConfig } from './config.js';

export interface MintedSessionKey {
  readonly token: string;
  readonly keyId: string;
}

/** Mints a short-lived CMA key via the Management API (admin token). */
export async function mintDelegatedKey(
  config: BffConfig,
  subject: string,
  groups: readonly string[],
): Promise<MintedSessionKey> {
  let roleId: string | undefined;
  for (const group of groups) {
    const mapped = config.oidcGroupRoleMap[group];
    if (mapped) {
      roleId = mapped;
      break;
    }
  }

  const res = await fetch(`${config.apiUrl}/spaces/${config.defaultSpace}/api-keys`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.adminToken}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      kind: 'cma',
      name: `oidc:${subject}`,
      roleId,
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to mint delegated key: ${res.status} ${text}`);
  }
  const body = (await res.json()) as { id: string; token: string };
  return { token: body.token, keyId: body.id };
}

export async function revokeDelegatedKey(config: BffConfig, keyId: string): Promise<void> {
  await fetch(`${config.apiUrl}/spaces/${config.defaultSpace}/api-keys/${keyId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${config.adminToken}` },
  });
}

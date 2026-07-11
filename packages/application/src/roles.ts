import {
  type ContentAction,
  type ContentTypeGrant,
  NotFoundError,
  type Role,
  SCOPES,
  ValidationError,
} from '@cw/domain';
import type { AppContext } from './context.js';

export interface RoleInput {
  readonly name: string;
  readonly description?: string;
  readonly scopes: readonly string[];
  readonly contentGrants?: readonly ContentTypeGrant[];
}

const KNOWN_SCOPES = new Set<string>(Object.values(SCOPES));
const KNOWN_ACTIONS = new Set<ContentAction>(['read', 'write', 'publish']);

function validateRoleInput(input: RoleInput): void {
  const issues: { field: string; message: string }[] = [];
  if (!input.name?.trim()) issues.push({ field: 'name', message: 'Role name is required' });
  for (const scope of input.scopes ?? []) {
    if (!KNOWN_SCOPES.has(scope)) {
      issues.push({ field: 'scopes', message: `Unknown scope "${scope}"` });
    }
  }
  for (const grant of input.contentGrants ?? []) {
    if (!grant.contentTypeApiId?.trim()) {
      issues.push({ field: 'contentGrants', message: 'contentTypeApiId is required' });
    }
    for (const action of grant.actions ?? []) {
      if (!KNOWN_ACTIONS.has(action)) {
        issues.push({ field: 'contentGrants', message: `Unknown action "${action}"` });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

/** Creates a custom role (granular RBAC) in a space. */
export async function createRole(
  ctx: AppContext,
  spaceId: string,
  input: RoleInput,
): Promise<Role> {
  validateRoleInput(input);
  const role: Role = {
    id: ctx.ids.newId(),
    spaceId,
    name: input.name,
    description: input.description,
    scopes: [...input.scopes],
    contentGrants: [...(input.contentGrants ?? [])],
  };
  await ctx.store.roles.save(role);
  return role;
}

/** Replaces a role's definition. Keys referencing it pick the change up live. */
export async function updateRole(
  ctx: AppContext,
  spaceId: string,
  id: string,
  input: RoleInput,
): Promise<Role> {
  validateRoleInput(input);
  const existing = await ctx.store.roles.get(spaceId, id);
  if (!existing) throw new NotFoundError('Role', id);
  const role: Role = {
    id,
    spaceId,
    name: input.name,
    description: input.description,
    scopes: [...input.scopes],
    contentGrants: [...(input.contentGrants ?? [])],
  };
  await ctx.store.roles.save(role);
  return role;
}

export async function getRole(ctx: AppContext, spaceId: string, id: string): Promise<Role> {
  const role = await ctx.store.roles.get(spaceId, id);
  if (!role) throw new NotFoundError('Role', id);
  return role;
}

export async function listRoles(ctx: AppContext, spaceId: string): Promise<Role[]> {
  return ctx.store.roles.list(spaceId);
}

/** Deletes a role. Refused while any API key still references it. */
export async function deleteRole(ctx: AppContext, spaceId: string, id: string): Promise<void> {
  const role = await ctx.store.roles.get(spaceId, id);
  if (!role) throw new NotFoundError('Role', id);
  const keys = await ctx.store.auth.list(spaceId);
  const holders = keys.filter((k) => k.roleId === id && !k.revoked);
  if (holders.length > 0) {
    throw new ValidationError([
      {
        field: 'id',
        message: `Role is assigned to ${holders.length} active API key(s); revoke them first`,
      },
    ]);
  }
  await ctx.store.roles.delete(spaceId, id);
}

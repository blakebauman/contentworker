import { DomainError } from '../errors.js';

/** The kind of API key — mirrors Contentful's CMA/CDA/CPA split. */
export type ApiKeyKind = 'cma' | 'cda' | 'cpa';

/** Permission scopes. A principal's scopes are checked per operation. */
export const SCOPES = {
  contentWrite: 'content:write',
  contentPublish: 'content:publish',
  contentManage: 'content:manage', // content type definitions
  deliveryRead: 'delivery:read', // published content
  previewRead: 'preview:read', // draft/current content
  searchRead: 'search:read',
  spaceAdmin: 'space:admin', // manage API keys
} as const;
export type PermissionScope = (typeof SCOPES)[keyof typeof SCOPES];

/** Default scope set granted to each key kind. */
export function scopesForKind(kind: ApiKeyKind): PermissionScope[] {
  switch (kind) {
    case 'cma':
      return [
        SCOPES.contentWrite,
        SCOPES.contentPublish,
        SCOPES.contentManage,
        SCOPES.deliveryRead,
        SCOPES.previewRead,
        SCOPES.searchRead,
        SCOPES.spaceAdmin,
      ];
    case 'cda':
      return [SCOPES.deliveryRead, SCOPES.searchRead];
    case 'cpa':
      return [SCOPES.previewRead, SCOPES.deliveryRead, SCOPES.searchRead];
  }
}

/** A stored API key. The raw token is never persisted — only its hash. */
export interface ApiKey {
  readonly id: string;
  readonly spaceId: string;
  readonly kind: ApiKeyKind;
  readonly name: string;
  readonly hashedToken: string;
  readonly scopes: readonly string[];
  readonly revoked: boolean;
}

/** The resolved identity of a request. `spaceId === '*'` is the admin/root scope. */
export interface Principal {
  readonly spaceId: string;
  readonly kind: ApiKeyKind | 'admin';
  readonly scopes: readonly string[];
}

export class UnauthorizedError extends DomainError {
  constructor(message = 'Invalid or missing credentials') {
    super('unauthorized', message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(scope: string) {
    super('forbidden', `Missing required scope "${scope}"`);
  }
}

/** True if the principal may act in `targetSpace`. Admin (`*`) may act anywhere. */
export function inScope(principal: Principal, targetSpaceId: string): boolean {
  return principal.spaceId === '*' || principal.spaceId === targetSpaceId;
}

/**
 * Enforces that the principal holds `scope` and is acting within its space.
 * Throws ForbiddenError otherwise. The single authorization decision point.
 */
export function authorize(
  principal: Principal,
  scope: PermissionScope,
  targetSpaceId: string,
): void {
  if (!inScope(principal, targetSpaceId) || !principal.scopes.includes(scope)) {
    throw new ForbiddenError(scope);
  }
}

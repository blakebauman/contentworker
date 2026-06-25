import { createHash } from 'node:crypto';
import type { AppContext, RagDeps } from '@cw/application';
import { authenticate } from '@cw/application';
import { type PermissionScope, type Principal, authorize, scopesForKind } from '@cw/domain';
import type { BlobStore, Hasher } from '@cw/ports';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const sha256Hasher: Hasher = {
  hash: (value: string) => createHash('sha256').update(value).digest('hex'),
};

/** Hono context variables carrying the resolved principal. */
export type AuthVars = { Variables: { principal: Principal } };

export interface AuthDeps {
  readonly ctx: AppContext;
  readonly hasher: Hasher;
  /** Root token granting all scopes across all spaces (provisioning/bootstrap). */
  readonly adminToken: string;
  /** Embeddings + vector store for the Delivery semantic-search endpoint. */
  readonly rag: RagDeps;
  /** Object storage for asset uploads/downloads. */
  readonly blob: BlobStore;
}

const ADMIN: Principal = {
  spaceId: '*',
  kind: 'admin',
  scopes: [...scopesForKind('cma')],
};

/**
 * Resolves the bearer token to a Principal and stores it on the context. The
 * admin token short-circuits to a wildcard principal; everything else is looked
 * up as a hashed API key.
 */
export function principalMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    if (deps.adminToken && token === deps.adminToken) {
      c.set('principal', ADMIN);
    } else {
      try {
        c.set('principal', await authenticate(deps.ctx, deps.hasher, token));
      } catch {
        throw new HTTPException(401, { message: 'Invalid or missing API key' });
      }
    }
    await next();
  };
}

/** Guards a route: the principal must hold `scope` within the route's :space. */
export function requireScope(scope: PermissionScope): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const principal = c.get('principal');
    const space = c.req.param('space');
    // authorize throws ForbiddenError → mapped to 403 by the error handler.
    authorize(principal, scope, space ?? '*');
    await next();
  };
}

import { createHash } from 'node:crypto';
import type { AppContext, RagDeps } from '@cw/application';
import { authenticate, recordAudit, resolveEnvironment } from '@cw/application';
import { type PermissionScope, type Principal, authorize, scopesForKind } from '@cw/domain';
import type { AIProvider, BlobStore, EventBus, Hasher } from '@cw/ports';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';

export const sha256Hasher: Hasher = {
  hash: (value: string) => createHash('sha256').update(value).digest('hex'),
};

/**
 * Hono context variables: the resolved principal, plus `environmentId` — the
 * concrete environment a request targets after alias resolution (set by
 * {@link environmentMiddleware}; `scopeOf` reads it, falling back to the raw param).
 */
export type AuthVars = { Variables: { principal: Principal; environmentId?: string } };

export interface AuthDeps {
  readonly ctx: AppContext;
  readonly hasher: Hasher;
  /** Root token granting all scopes across all spaces (provisioning/bootstrap). */
  readonly adminToken: string;
  /** Embeddings + vector store for the Delivery semantic-search endpoint. */
  readonly rag: RagDeps;
  /** Object storage for asset uploads/downloads. */
  readonly blob: BlobStore;
  /** AI provider for entry generation. */
  readonly ai: AIProvider;
  /** Domain-event source for the Live Content API (SSE). */
  readonly bus: EventBus;
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

/**
 * Resolves the route's `:env` param through environment aliases and stamps the
 * concrete environment id onto the context. Mounted on the scoped path prefixes
 * so an alias name works anywhere `:env` does. A direct environment reference
 * resolves to itself (one indexed lookup).
 */
export function environmentMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const space = c.req.param('space');
    const env = c.req.param('env');
    if (space && env) {
      c.set('environmentId', await resolveEnvironment(deps.ctx, space, env));
    }
    await next();
  };
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Records successful mutating requests to the append-only audit trail. Runs
 * after the handler so it can capture the response status; a failed audit write
 * never fails the request. The actor is the principal kind (no user model yet).
 */
export function auditMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    await next();
    const space = c.req.param('space');
    if (!MUTATING.has(c.req.method) || !space || c.res.status >= 400) return;
    try {
      await recordAudit(deps.ctx, {
        spaceId: space,
        environmentId: c.get('environmentId') ?? c.req.param('env'),
        actor: c.get('principal')?.kind ?? 'unknown',
        action: `${c.req.method} ${c.req.routePath}`,
        targetId: c.req.param('id') ?? c.req.param('apiId') ?? c.req.param('alias'),
        status: c.res.status,
      });
    } catch {
      /* auditing must never break the request path */
    }
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

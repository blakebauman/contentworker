import {
  authenticate,
  createHasher,
  recordAudit,
  resolveEnvironment,
  secureTokenEqual,
} from '@cw/application';
import type { AgentRunner, AppContext } from '@cw/application';
import { type PermissionScope, type Principal, authorize, scopesForKind } from '@cw/domain';
import type { AIProvider, BlobStore, EventBus, Hasher, RagDeps } from '@cw/ports';
import { logger } from '@cw/telemetry';
import type { MiddlewareHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { AuthRateLimiter, clientIp } from './auth-rate-limit.js';

/** Default SHA-256 hasher (no pepper). Prefer {@link createApiHasher} in production. */
export const sha256Hasher = createHasher();

/** Builds the API hasher, applying TOKEN_PEPPER when configured. */
export function createApiHasher(pepper?: string): Hasher {
  return createHasher(pepper);
}

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
  /** Agent-workflow runtime for on-demand agent actions (moderation). */
  readonly agents: AgentRunner;
  /** Domain-event source for the Live Content API (SSE). */
  readonly bus: EventBus;
}

const ADMIN: Principal = {
  spaceId: '*',
  kind: 'admin',
  scopes: [...scopesForKind('cma')],
};

const authRateLimiter = new AuthRateLimiter(
  Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
  Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000),
);

function auditActor(principal: Principal): string {
  if (principal.kind === 'admin') return 'admin-token';
  if (principal.kind === 'user' && principal.subject) return principal.subject;
  return principal.kind;
}

async function resolvePrincipal(deps: AuthDeps, token: string): Promise<Principal> {
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) {
    return ADMIN;
  }
  return authenticate(deps.ctx, deps.hasher, token);
}

/**
 * Resolves the bearer token to a Principal and stores it on the context. The
 * admin token short-circuits to a wildcard principal; everything else is looked
 * up as a hashed API key.
 */
export function principalMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    const ip = clientIp(c.req.header('x-forwarded-for'), c.req.header('x-real-ip'));
    if (authRateLimiter.isBlocked(ip)) {
      logger.warn({ ip, path: c.req.path }, 'auth: rate limit exceeded');
      throw new HTTPException(429, { message: 'Too many authentication attempts' });
    }

    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    try {
      const principal = await resolvePrincipal(deps, token);
      authRateLimiter.clear(ip);
      c.set('principal', principal);
    } catch {
      const limited = authRateLimiter.recordFailure(ip);
      logger.warn({ ip, path: c.req.path, method: c.req.method }, 'auth: invalid credentials');
      if (limited) {
        throw new HTTPException(429, { message: 'Too many authentication attempts' });
      }
      throw new HTTPException(401, { message: 'Invalid or missing API key' });
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
 * never fails the request.
 */
export function auditMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    await next();
    const space = c.req.param('space');
    if (!MUTATING.has(c.req.method) || !space || c.res.status >= 400) return;
    try {
      const principal = c.get('principal');
      await recordAudit(deps.ctx, {
        spaceId: space,
        environmentId: c.get('environmentId') ?? c.req.param('env'),
        actor: auditActor(principal),
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

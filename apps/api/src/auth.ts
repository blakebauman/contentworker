import {
  authenticate,
  createHasher,
  recordAudit,
  resolveEnvironment,
  secureTokenEqual,
} from '@cw/application';
import type { AgentRunner, AppContext, RagDeps } from '@cw/application';
import {
  type AgentReview,
  type PermissionScope,
  type Principal,
  authorize,
  scopesForKind,
} from '@cw/domain';
import type { AIProvider, BlobStore, EventBus, Hasher } from '@cw/ports';
import { logger } from '@cw/telemetry';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { HTTPException } from 'hono/http-exception';
import { type AuthRateLimit, AuthRateLimiter, clientIp } from './auth-rate-limit.js';

export type { AuthRateLimit } from './auth-rate-limit.js';
import { decodeSession, sessionCookieName } from './oidc/session.js';

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
  /** Delivers review decisions to a durable HITL watcher (optional). */
  readonly signalReview?: (
    review: AgentReview,
    decision: 'approved' | 'rejected',
  ) => Promise<boolean>;
  /** Validates admin SSO session cookies when no bearer token is sent. */
  readonly sessionSecret?: string;
  /**
   * Failed-auth rate limiter. Defaults to the in-process sliding window;
   * multi-isolate runtimes (Cloudflare Workers) inject a shared-state one.
   */
  readonly rateLimiter?: AuthRateLimit;
  /** Number of trusted reverse proxies in front (for X-Forwarded-For parsing). */
  readonly trustedProxyCount?: number;
  /** When true, publish runs moderation first and blocks flagged content. */
  readonly moderateBeforePublish?: boolean;
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

function resolveRequestToken(deps: AuthDeps, c: Context): string {
  const bearer = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (bearer) return bearer;
  if (deps.sessionSecret) {
    const session = decodeSession(getCookie(c, sessionCookieName()), deps.sessionSecret);
    if (session) return session.apiToken;
  }
  return '';
}

/**
 * Resolves the bearer token (or admin SSO session cookie) to a Principal and
 * stores it on the context. The admin token short-circuits to a wildcard
 * principal; everything else is looked up as a hashed API key.
 */
function requestIp(deps: AuthDeps, c: Context): string {
  // CF-Connecting-IP first (Cloudflare-set, not forgeable); otherwise parse
  // X-Forwarded-For from the right by trusted-proxy depth so a client can't
  // spoof a fresh rate-limit key per request.
  return clientIp({
    cfConnectingIp: c.req.header('cf-connecting-ip'),
    forwardedFor: c.req.header('x-forwarded-for'),
    realIp: c.req.header('x-real-ip'),
    trustedProxyCount: deps.trustedProxyCount,
  });
}

/**
 * Runs a credential resolution under the failed-auth rate limiter: rejects with
 * 429 when the client IP is already blocked, clears the window on success, and
 * records a failure (429 once the limit trips) on error. Shared by the bearer
 * middleware and the preview route so every credential-checking path is
 * throttled uniformly.
 */
export async function throttleAuth<T>(
  deps: AuthDeps,
  c: Context,
  resolve: () => Promise<T>,
): Promise<T> {
  const ip = requestIp(deps, c);
  const limiter = deps.rateLimiter ?? authRateLimiter;
  if (await limiter.isBlocked(ip)) {
    logger.warn({ ip, path: c.req.path }, 'auth: rate limit exceeded');
    throw new HTTPException(429, { message: 'Too many authentication attempts' });
  }
  try {
    const result = await resolve();
    await limiter.clear(ip);
    return result;
  } catch (err) {
    const limited = await limiter.recordFailure(ip);
    logger.warn({ ip, path: c.req.path, method: c.req.method }, 'auth: invalid credentials');
    if (limited) throw new HTTPException(429, { message: 'Too many authentication attempts' });
    throw err;
  }
}

export function principalMiddleware(deps: AuthDeps): MiddlewareHandler<AuthVars> {
  return async (c, next) => {
    // No credentials presented → plain 401 with no limiter interaction: an
    // empty bearer can't brute-force anything, and unauthenticated probes
    // (e.g. the admin SPA checking for a session) must never exhaust the IP's
    // failure budget.
    const token = resolveRequestToken(deps, c);
    if (!token) {
      throw new HTTPException(401, { message: 'Invalid or missing API key' });
    }
    let principal: Principal;
    try {
      principal = await throttleAuth(deps, c, () => resolvePrincipal(deps, token));
    } catch (err) {
      // Preserve the limiter's 429; collapse any auth failure to a plain 401.
      if (err instanceof HTTPException) throw err;
      throw new HTTPException(401, { message: 'Invalid or missing API key' });
    }
    c.set('principal', principal);
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

import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '@cw/api/auth';
import { SCOPES } from '@cw/domain';
import { Hono } from 'hono';
import type { LiveHubDO } from '../do/live-hub.js';

/**
 * Cloudflare-native Live Content API: authorizes exactly like the stock
 * delivery route (same middleware chain, same path), then forwards the request
 * to the scope's LiveHubDO, which serves the SSE stream itself. Mounted BEFORE
 * the stock delivery routes so it wins first-match.
 */
export function liveRoutes(deps: AuthDeps, ns: DurableObjectNamespace<LiveHubDO>): Hono<AuthVars> {
  const app = new Hono<AuthVars>();
  app.get(
    '/delivery/:space/:env/live',
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.deliveryRead),
    (c) => {
      const spaceId = c.req.param('space');
      const environmentId = c.get('environmentId') ?? c.req.param('env');
      const stub = ns.get(ns.idFromName(`${spaceId}:${environmentId}`));
      return stub.fetch(c.req.raw);
    },
  );
  return app;
}

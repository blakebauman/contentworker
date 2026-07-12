import { authenticate, secureTokenEqual } from '@cw/application';
import { type Principal, scopesForKind } from '@cw/domain';
import { buildServer } from '@cw/mcp-server/server';
import type { McpDeps } from '@cw/mcp-server/wire';
import { StreamableHTTPTransport } from '@hono/mcp';
import { Hono } from 'hono';

const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };

/**
 * Stateless streamable-HTTP MCP endpoint — the fetch-native equivalent of
 * apps/mcp-server/src/main.ts (node:http). Same auth (MCP root token or hashed
 * API key), same buildServer, so tool definitions stay single-sourced.
 */
export function mcpRoutes(deps: McpDeps): Hono {
  const app = new Hono();
  app.post('/mcp', async (c) => {
    const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
    const principal = await resolvePrincipal(deps, token);
    if (!principal) return c.json({ error: 'invalid or missing bearer token' }, 401);

    const server = buildServer(deps, principal);
    const transport = new StreamableHTTPTransport();
    await server.connect(transport);
    return transport.handleRequest(c);
  });
  return app;
}

async function resolvePrincipal(deps: McpDeps, token: string): Promise<Principal | null> {
  if (!token) return null;
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) return ADMIN;
  try {
    return await authenticate(deps.ctx, deps.hasher, token);
  } catch {
    return null;
  }
}

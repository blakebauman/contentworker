import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import {
  assertSecureSecrets,
  requireSecureSecretsFromEnv,
  secureTokenEqual,
} from '@cw/application';
import { authenticate } from '@cw/application';
import { type Principal, scopesForKind } from '@cw/domain';
import { logger, startTelemetry } from '@cw/telemetry';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { wire } from './wire.js';

startTelemetry('cw-mcp');

const deps = wire();
// The MCP server's single bearer IS its admin token, so validate it once as
// adminToken. Passing it as both adminToken and mcpToken previously tripped the
// "ADMIN_TOKEN and MCP_TOKEN must differ" rule on every secure startup.
assertSecureSecrets({
  requireSecureSecrets: requireSecureSecretsFromEnv(process.env),
  seedDev: false,
  adminToken: deps.adminToken,
});

const port = Number(process.env.PORT ?? 8788);

const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };

// In-process failed-auth limiter (per client key) so bearer-token guessing is
// throttled. A stateless multi-replica MCP deployment gets per-instance windows,
// matching the API's in-process default.
const AUTH_MAX = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10);
const AUTH_WINDOW_MS = Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000);
const authFailures = new Map<string, number[]>();
function recentFailures(key: string): number[] {
  const since = Date.now() - AUTH_WINDOW_MS;
  const recent = (authFailures.get(key) ?? []).filter((t) => t > since);
  authFailures.set(key, recent);
  return recent;
}
function clientKey(req: IncomingMessage): string {
  const xff = (req.headers['x-forwarded-for'] as string | undefined)?.split(',');
  return xff?.at(-1)?.trim() || req.socket.remoteAddress || 'unknown';
}

/** Resolves the bearer token to a Principal (admin token or hashed API key). */
async function resolvePrincipal(token: string): Promise<Principal | null> {
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) return ADMIN;
  try {
    return await authenticate(deps.ctx, deps.hasher, token);
  } catch {
    return null;
  }
}

function unauthorized(res: ServerResponse) {
  res.writeHead(401, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'invalid or missing bearer token' }));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Stateless streamable-HTTP MCP server. Each request gets a fresh server +
 * transport (sessionIdGenerator undefined), so it scales as a plain stateless
 * Deployment. Auth is a bearer token validated against MCP_TOKEN.
 */
const httpServer = createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.startsWith('/mcp')) {
    res.writeHead(404).end();
    return;
  }

  const key = clientKey(req);
  if (recentFailures(key).length >= AUTH_MAX) {
    logger.warn({ path: req.url }, 'mcp: rate limit exceeded');
    res.writeHead(429, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'too many authentication attempts' }));
    return;
  }
  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const principal = token ? await resolvePrincipal(token) : null;
  if (!principal) {
    if (token) recentFailures(key).push(Date.now());
    logger.warn({ path: req.url }, 'mcp: invalid credentials');
    unauthorized(res);
    return;
  }
  authFailures.delete(key);

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = buildServer(deps, principal);
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, await readBody(req));
  } catch (err) {
    if (!res.headersSent) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'internal error' }));
    }
  }
});

httpServer.listen(port, () => {
  const mode = process.env.DATABASE_URL ? 'postgres' : 'in-memory';
  const provider = process.env.AI_PROVIDER ?? 'anthropic';
  logger.info({ port, mode, ai: provider }, 'contentworker mcp-server listening');
});

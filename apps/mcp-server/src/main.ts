import { type IncomingMessage, type ServerResponse, createServer } from 'node:http';
import { authenticate } from '@cw/application';
import { type Principal, scopesForKind } from '@cw/domain';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildServer } from './server.js';
import { wire } from './wire.js';

const deps = wire();
const port = Number(process.env.PORT ?? 8788);

const ADMIN: Principal = { spaceId: '*', kind: 'admin', scopes: [...scopesForKind('cma')] };

/** Resolves the bearer token to a Principal (admin token or hashed API key). */
async function resolvePrincipal(token: string): Promise<Principal | null> {
  if (deps.adminToken && token === deps.adminToken) return ADMIN;
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

  const token = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const principal = await resolvePrincipal(token);
  if (!principal) {
    unauthorized(res);
    return;
  }

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
  // eslint-disable-next-line no-console
  console.log(`contentworker mcp-server on http://localhost:${port}/mcp (${mode}, ai=${provider})`);
});

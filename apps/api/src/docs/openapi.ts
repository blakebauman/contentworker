import { Scalar } from '@scalar/hono-api-reference';
import type { Hono } from 'hono';
import { type DescribeRouteOptions, describeRoute, generateSpecs, resolver } from 'hono-openapi';
import type { ApiConfig } from '../config.js';
import { errorResponse } from './schemas.js';

/** Standard-schema (zod) type accepted by hono-openapi's resolver. */
type AnySchema = Parameters<typeof resolver>[0];

/**
 * describeRoute options with the house style baked in: tag, summary, a JSON
 * 200 response when a schema is given, and the standard auth error responses.
 * Routes without an explicit description still appear in the spec via route
 * introspection — this helper is for the ones worth documenting richly.
 */
export function doc(
  tag: string,
  summary: string,
  opts: {
    ok?: AnySchema;
    okDescription?: string;
    status?: number;
    description?: string;
    query?: Record<string, string>;
  } = {},
) {
  const status = opts.status ?? 200;
  const spec: DescribeRouteOptions = {
    tags: [tag],
    summary,
    description: opts.description,
    ...(opts.query
      ? {
          parameters: Object.entries(opts.query).map(([name, description]) => ({
            name,
            in: 'query' as const,
            required: false,
            schema: { type: 'string' as const },
            description,
          })),
        }
      : {}),
    responses: {
      [status]: {
        description: opts.okDescription ?? 'Success',
        ...(opts.ok ? { content: { 'application/json': { schema: resolver(opts.ok) } } } : {}),
      },
      401: {
        description: 'Missing or invalid bearer token',
        content: { 'application/json': { schema: resolver(errorResponse) } },
      },
      403: {
        description: 'Token lacks the required scope for this space',
        content: { 'application/json': { schema: resolver(errorResponse) } },
      },
    },
  };
  return describeRoute(spec);
}

const DOCUMENTED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const HIDDEN_PATHS = new Set(['/openapi.json', '/docs']);

/** Hono `:param` syntax → OpenAPI `{param}`. */
const toOpenApiPath = (path: string) => path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

/**
 * Adds a bare operation for every mounted route the spec doesn't already
 * cover — hono-openapi only emits `describeRoute`-annotated routes, but the
 * spec should be a complete inventory. Hono registers each middleware in a
 * handler chain as its own RouterRoute with the same method+path, so `??=`
 * dedupes; `use()`-style wildcard paths and non-HTTP methods are skipped.
 */
function addUndescribedRoutes(app: Hono, paths: Record<string, Record<string, unknown>>): void {
  for (const route of app.routes) {
    if (!DOCUMENTED_METHODS.has(route.method)) continue;
    if (route.path.includes('*')) continue;
    const path = toOpenApiPath(route.path);
    if (HIDDEN_PATHS.has(path) || path.startsWith('/graphiql')) continue;
    const method = route.method.toLowerCase();
    paths[path] ??= {};
    paths[path][method] ??= {
      summary: `${route.method} ${path}`,
      parameters: [...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map((m) => ({
        name: m[1],
        in: 'path',
        required: true,
        schema: { type: 'string' },
      })),
      responses: { 200: { description: 'Success' } },
    };
  }
}

/**
 * Mounts GET /openapi.json and GET /docs (Scalar UI). The spec merges the
 * richly-described routes (`doc()` annotations with schemas) with a bare
 * inventory of every other mounted route. Called last in createApp so
 * introspection sees all modules — the spec therefore honestly reflects the
 * ROLE gating of this deployment.
 */
export function mountDocs(app: Hono, config: ApiConfig): void {
  app.get('/openapi.json', async (c) => {
    const spec = await generateSpecs(
      app,
      {
        documentation: {
          info: {
            title: 'contentworker API',
            version: '0.1.0',
            description: `API-first, AI-agentic-first headless CMS. Management (CMA), Delivery (CDA), and Preview (CPA) surfaces — this deployment serves role "${config.role}". Every capability is also exposed as an MCP tool at POST /mcp.`,
          },
          components: {
            securitySchemes: {
              bearerAuth: {
                type: 'http',
                scheme: 'bearer',
                description:
                  'API key (CMA/CDA/CPA, hashed at rest) or the admin token. Keys are minted at ' +
                  'POST /spaces/{space}/api-keys.',
              },
            },
          },
          security: [{ bearerAuth: [] }],
        },
        exclude: ['/openapi.json', '/docs', /^\/graphiql/],
      },
      c,
    );
    const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;
    addUndescribedRoutes(app, paths);
    spec.paths = paths;
    return c.json(spec);
  });
  app.get('/docs', Scalar({ url: '/openapi.json', pageTitle: 'contentworker API' }));
}

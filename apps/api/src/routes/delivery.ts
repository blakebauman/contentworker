import {
  getPublishedAsset,
  getPublishedEntry,
  listContentTypes,
  listPublishedAssets,
  listPublishedEntries,
  semanticSearch,
} from '@cw/application';
import { SCOPES, type Scope } from '@cw/domain';
import { type DeliveryResolvers, type ResolvedEntry, buildDeliverySchema } from '@cw/graphql-gen';
import { type GraphQLSchema, graphql } from 'graphql';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, principalMiddleware, requireScope } from '../auth.js';

const scopeOf = (c: { req: { param: (k: string) => string } }): Scope => ({
  spaceId: c.req.param('space'),
  environmentId: c.req.param('env'),
});

const BASE = '/delivery/:space/:env';

/** Delivery API (CDA): read-only published content. Requires delivery:read. */
export function deliveryRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, rag } = deps;
  const app = new Hono<AuthVars>();
  app.use(`${BASE}/*`, principalMiddleware(deps));

  app.get(`${BASE}/search`, requireScope(SCOPES.searchRead), async (c) => {
    const q = c.req.query('q') ?? '';
    const topK = c.req.query('top_k');
    const hits = await semanticSearch(rag, scopeOf(c), q, {
      topK: topK ? Number(topK) : undefined,
    });
    return c.json({ hits });
  });

  app.get(`${BASE}/entries`, requireScope(SCOPES.deliveryRead), async (c) => {
    const include = c.req.query('include');
    const limit = c.req.query('limit');
    const items = await listPublishedEntries(
      ctx,
      scopeOf(c),
      {
        contentTypeApiId: c.req.query('content_type'),
        limit: limit ? Number(limit) : undefined,
        skip: c.req.query('skip') ? Number(c.req.query('skip')) : undefined,
        since: c.req.query('since'),
      },
      { locale: c.req.query('locale'), include: include ? Number(include) : undefined },
    );
    return c.json({ items, total: items.length });
  });

  app.get(`${BASE}/entries/:id`, requireScope(SCOPES.deliveryRead), async (c) => {
    const include = c.req.query('include');
    return c.json(
      await getPublishedEntry(ctx, scopeOf(c), c.req.param('id'), {
        locale: c.req.query('locale'),
        include: include ? Number(include) : undefined,
      }),
    );
  });

  app.get(`${BASE}/assets`, requireScope(SCOPES.deliveryRead), async (c) => {
    const limit = c.req.query('limit');
    const items = await listPublishedAssets(ctx, scopeOf(c), {
      limit: limit ? Number(limit) : undefined,
    });
    return c.json({ items, total: items.length });
  });

  app.get(`${BASE}/assets/:id`, requireScope(SCOPES.deliveryRead), async (c) =>
    c.json(await getPublishedAsset(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- GraphQL Delivery ---------------------------------------------------
  // Schema is generated from published content types and cached per scope; it
  // rebuilds automatically when the content-type set/versions change.
  const schemaCache = new Map<string, { hash: string; schema: GraphQLSchema }>();

  async function schemaFor(scope: Scope): Promise<GraphQLSchema> {
    const types = await listContentTypes(ctx, scope);
    const hash = types
      .map((t) => `${t.apiId}@${t.version}`)
      .sort()
      .join(',');
    const key = `${scope.spaceId}:${scope.environmentId}`;
    const cached = schemaCache.get(key);
    if (cached && cached.hash === hash) return cached.schema;

    const resolvers: DeliveryResolvers = {
      entry: async (contentType, id, locale) => {
        try {
          const e = await getPublishedEntry(ctx, scope, id, { locale, include: 1 });
          return e.contentType === contentType ? (e as ResolvedEntry) : null;
        } catch {
          return null;
        }
      },
      collection: (contentType, args) =>
        listPublishedEntries(
          ctx,
          scope,
          { contentTypeApiId: contentType, limit: args.limit, skip: args.skip },
          { locale: args.locale, include: 1 },
        ) as Promise<ResolvedEntry[]>,
      asset: async (id, _locale) => {
        try {
          const a = await getPublishedAsset(ctx, scope, id);
          return { id: a.assetId, file: a.file, title: a.title, description: a.description };
        } catch {
          return null;
        }
      },
      search: (query, topK) => semanticSearch(rag, scope, query, { topK }),
    };
    const schema = buildDeliverySchema(types, resolvers);
    schemaCache.set(key, { hash, schema });
    return schema;
  }

  // In-browser GraphQL explorer. Registered OUTSIDE the guarded BASE/* prefix so
  // the page loads without a token; the user sets the bearer in GraphiQL's header
  // editor and the /graphql POST it issues is what gets scope-checked.
  app.get('/graphiql/:space/:env', (c) =>
    c.html(graphiqlHtml(`/delivery/${c.req.param('space')}/${c.req.param('env')}/graphql`)),
  );

  app.all(`${BASE}/graphql`, requireScope(SCOPES.deliveryRead), async (c) => {
    const body = c.req.method === 'POST' ? await c.req.json().catch(() => ({})) : {};
    const source = (body as { query?: string }).query ?? c.req.query('query');
    if (!source) return c.json({ errors: [{ message: 'No GraphQL query provided' }] }, 400);
    const result = await graphql({
      schema: await schemaFor(scopeOf(c)),
      source,
      variableValues: (body as { variables?: Record<string, unknown> }).variables,
      operationName: (body as { operationName?: string }).operationName,
    });
    return c.json(result);
  });

  return app;
}

/** Minimal GraphiQL explorer page (CDN-hosted assets) wired to `endpoint`. */
function graphiqlHtml(endpoint: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>contentworker GraphiQL</title>
    <style>body,#graphiql{height:100vh;margin:0}</style>
    <link rel="stylesheet" href="https://unpkg.com/graphiql/graphiql.min.css" />
  </head>
  <body>
    <div id="graphiql">Loading…</div>
    <script src="https://unpkg.com/react@18/umd/react.production.min.js"></script>
    <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js"></script>
    <script src="https://unpkg.com/graphiql/graphiql.min.js"></script>
    <script>
      const fetcher = GraphiQL.createFetcher({ url: ${JSON.stringify(endpoint)} });
      ReactDOM.createRoot(document.getElementById('graphiql')).render(
        React.createElement(GraphiQL, {
          fetcher,
          defaultHeaders: JSON.stringify({ Authorization: 'Bearer dev-cda-key' }, null, 2),
        }),
      );
    </script>
  </body>
</html>`;
}

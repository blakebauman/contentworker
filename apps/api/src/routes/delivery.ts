import {
  getPublishedAsset,
  getPublishedEntry,
  listPublishedAssets,
  listPublishedEntries,
  semanticSearch,
} from '@cw/application';
import { SCOPES, type Scope } from '@cw/domain';
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

  return app;
}

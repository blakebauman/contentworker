import { getPreviewEntry, listPreviewEntries } from '@cw/application';
import { SCOPES, type Scope } from '@cw/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, principalMiddleware, requireScope } from '../auth.js';

const scopeOf = (c: { req: { param: (k: string) => string } }): Scope => ({
  spaceId: c.req.param('space'),
  environmentId: c.req.param('env'),
});

const BASE = '/preview/:space/:env';

/** Preview API (CPA): read draft/current content. Requires preview:read. */
export function previewRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();
  app.use(`${BASE}/*`, principalMiddleware(deps));

  app.get(`${BASE}/entries`, requireScope(SCOPES.previewRead), async (c) => {
    const items = await listPreviewEntries(
      ctx,
      scopeOf(c),
      { contentTypeApiId: c.req.query('content_type') },
      { locale: c.req.query('locale') },
    );
    return c.json({ items, total: items.length });
  });

  app.get(`${BASE}/entries/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await getPreviewEntry(ctx, scopeOf(c), c.req.param('id'), { locale: c.req.query('locale') }),
    ),
  );

  return app;
}

import { getPreviewEntry, listPreviewEntries } from '@cw/application';
import { SCOPES, type Scope } from '@cw/domain';
import { type Context, Hono } from 'hono';
import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../auth.js';
import { parseEntryQuery } from '../query.js';

const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

const BASE = '/preview/:space/:env';

/** Preview API (CPA): read draft/current content. Requires preview:read. */
export function previewRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();
  app.use(`${BASE}/*`, principalMiddleware(deps));
  app.use(`${BASE}/*`, environmentMiddleware(deps));

  app.get(`${BASE}/entries`, requireScope(SCOPES.previewRead), async (c) => {
    const query = parseEntryQuery(new URL(c.req.url).searchParams);
    const items = await listPreviewEntries(ctx, scopeOf(c), query, {
      locale: c.req.query('locale'),
    });
    return c.json({ items, total: items.length });
  });

  app.get(`${BASE}/entries/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await getPreviewEntry(ctx, scopeOf(c), c.req.param('id'), { locale: c.req.query('locale') }),
    ),
  );

  return app;
}

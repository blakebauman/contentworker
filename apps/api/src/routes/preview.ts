import { getPreviewEntry, listPreviewEntries } from '@cw/application';
import {
  SCOPES,
  type Scope,
  authorizeContent,
  canAccessContentType,
  maskDeniedFields,
} from '@cw/domain';
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
    // Granular RBAC: drop entries of ungranted types, mask denied fields.
    const principal = c.get('principal');
    const visible = items
      .filter((e) => canAccessContentType(principal, 'read', e.contentType))
      .map((e) => ({ ...e, fields: maskDeniedFields(principal, e.contentType, e.fields) }));
    return c.json({ items: visible, total: visible.length });
  });

  app.get(`${BASE}/entries/:id`, requireScope(SCOPES.previewRead), async (c) => {
    const entry = await getPreviewEntry(ctx, scopeOf(c), c.req.param('id'), {
      locale: c.req.query('locale'),
    });
    const principal = c.get('principal');
    authorizeContent(principal, 'read', entry.contentType);
    return c.json({
      ...entry,
      fields: maskDeniedFields(principal, entry.contentType, entry.fields),
    });
  });

  return app;
}

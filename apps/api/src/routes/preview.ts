import {
  authenticate,
  getPreviewEntry,
  listPreviewEntries,
  principalFromPreviewToken,
  secureTokenEqual,
} from '@cw/application';
import {
  type Principal,
  SCOPES,
  type Scope,
  authorize,
  authorizeContent,
  canAccessContentType,
  maskDeniedFields,
  scopesForKind,
} from '@cw/domain';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import {
  type AuthDeps,
  type AuthVars,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
  throttleAuth,
} from '../auth.js';
import { doc } from '../docs/openapi.js';
import { publishedEntryList } from '../docs/schemas.js';
import { parseEntryQuery } from '../query.js';

const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

const BASE = '/preview/:space/:env';

const ADMIN: Principal = {
  spaceId: '*',
  kind: 'admin',
  scopes: [...scopesForKind('cma')],
};

async function resolvePreviewPrincipal(
  deps: AuthDeps,
  c: Context<AuthVars>,
  entryId: string,
): Promise<Principal> {
  const previewToken = c.req.query('preview_token');
  if (previewToken) {
    const fromToken = await principalFromPreviewToken(
      deps.ctx,
      deps.hasher,
      scopeOf(c),
      entryId,
      previewToken,
    );
    if (!fromToken) {
      throw new HTTPException(401, { message: 'Invalid or expired preview token' });
    }
    return fromToken;
  }

  const token = (c.req.header('authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (deps.adminToken && secureTokenEqual(token, deps.adminToken)) return ADMIN;
  return authenticate(deps.ctx, deps.hasher, token);
}

/** Preview API (CPA): read draft/current content. Requires preview:read. */
export function previewRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx } = deps;
  const app = new Hono<AuthVars>();

  app.get(
    `${BASE}/entries`,
    doc('Preview', 'List draft/current entries', {
      ok: publishedEntryList,
      query: { content_type: 'Filter by content type apiId', locale: 'Resolve one locale' },
    }),
    principalMiddleware(deps),
    environmentMiddleware(deps),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const query = parseEntryQuery(new URL(c.req.url).searchParams);
      const items = await listPreviewEntries(ctx, scopeOf(c), query, {
        locale: c.req.query('locale'),
      });
      const principal = c.get('principal');
      const visible = items
        .filter((e) => canAccessContentType(principal, 'read', e.contentType))
        .map((e) => ({ ...e, fields: maskDeniedFields(principal, e.contentType, e.fields) }));
      return c.json({ items: visible, total: visible.length });
    },
  );

  // Shareable preview links use ?preview_token= instead of a bearer header.
  app.get(
    `${BASE}/entries/:id`,
    doc('Preview', 'Get a draft/current entry', {
      description: 'Accepts a bearer token or a shareable ?preview_token= minted from the entry.',
      query: { locale: 'Resolve one locale', preview_token: 'Shareable preview token' },
    }),
    environmentMiddleware(deps),
    async (c) => {
      const entryId = c.req.param('id');
      // Throttle credential resolution so preview-token / bearer guessing on this
      // route is bounded by the same failed-auth budget as the bearer middleware.
      const principal = await throttleAuth(deps, c, () =>
        resolvePreviewPrincipal(deps, c, entryId),
      );
      authorize(principal, SCOPES.previewRead, scopeOf(c).spaceId);

      const entry = await getPreviewEntry(ctx, scopeOf(c), entryId, {
        locale: c.req.query('locale'),
      });
      authorizeContent(principal, 'read', entry.contentType);
      return c.json({
        ...entry,
        fields: maskDeniedFields(principal, entry.contentType, entry.fields),
      });
    },
  );

  return app;
}

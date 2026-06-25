import {
  agentUsage,
  createApiKey,
  createAsset,
  createContentType,
  createEntry,
  createEnvironment,
  createSpace,
  createWebhook,
  deleteWebhook,
  draftEntry,
  getAsset,
  getContentType,
  getEntry,
  getReverseReferences,
  getSpaceConfig,
  listAgentRuns,
  listApiKeys,
  listAssets,
  listContentTypes,
  listWebhooks,
  publishAsset,
  publishContentType,
  publishEntry,
  revokeApiKey,
  unpublishAsset,
  unpublishEntry,
  updateEntry,
  updateWebhook,
} from '@cw/application';
import { SCOPES, type Scope } from '@cw/domain';
import { Hono } from 'hono';
import { type AuthDeps, type AuthVars, principalMiddleware, requireScope } from '../auth.js';

const scopeOf = (c: { req: { param: (k: string) => string } }): Scope => ({
  spaceId: c.req.param('space'),
  environmentId: c.req.param('env'),
});

const BASE = '/spaces/:space/environments/:env';

/** Management API (CMA): authoring + publishing, gated by RBAC scopes. */
export function managementRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher, blob, ai } = deps;
  const app = new Hono<AuthVars>();
  app.use('/spaces', principalMiddleware(deps));
  app.use('/spaces/*', principalMiddleware(deps));

  // --- provisioning (admin) ----------------------------------------------
  app.post('/spaces', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await c.req.json();
    return c.json(await createSpace(ctx, body), 201);
  });

  app.post('/spaces/:space/environments', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await c.req.json();
    await createEnvironment(ctx, c.req.param('space'), body.id, body.name);
    return c.json({ id: body.id }, 201);
  });

  // --- API key management (admin) ----------------------------------------
  app.get('/spaces/:space/api-keys', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: await listApiKeys(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/api-keys', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await c.req.json();
    const created = await createApiKey(ctx, hasher, { spaceId: c.req.param('space'), ...body });
    // Return the raw token once; only its hash is stored.
    return c.json({ id: created.apiKey.id, kind: created.apiKey.kind, token: created.token }, 201);
  });
  app.delete('/spaces/:space/api-keys/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await revokeApiKey(ctx, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- space config (locales) --------------------------------------------
  app.get(`${BASE}/space-config`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getSpaceConfig(ctx, scopeOf(c))),
  );

  // --- content types ------------------------------------------------------
  app.get(`${BASE}/content-types`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listContentTypes(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/content-types`, requireScope(SCOPES.contentManage), async (c) => {
    const ct = await createContentType(ctx, scopeOf(c), await c.req.json());
    return c.json(ct, 201);
  });
  app.get(`${BASE}/content-types/:apiId`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );
  app.post(
    `${BASE}/content-types/:apiId/published`,
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await publishContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );

  // --- entries ------------------------------------------------------------
  app.post(`${BASE}/entries`, requireScope(SCOPES.contentWrite), async (c) => {
    const view = await createEntry(ctx, scopeOf(c), await c.req.json());
    return c.json(view, 201);
  });
  // AI-draft an entry's fields. Generated values pass the same validators a
  // human write does, so an agent can't produce an entry a person couldn't.
  app.post(`${BASE}/entries/generate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await draftEntry(ctx, ai, scopeOf(c), await c.req.json())),
  );
  app.get(`${BASE}/entries/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getEntry(ctx, scopeOf(c), c.req.param('id'))),
  );
  // "What links here": entries/assets that reference this entry.
  app.get(`${BASE}/entries/:id/reverse-references`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await getReverseReferences(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.put(`${BASE}/entries/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await c.req.json();
    return c.json(await updateEntry(ctx, scopeOf(c), c.req.param('id'), body.fields));
  });
  app.post(`${BASE}/entries/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishEntry(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/entries/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await unpublishEntry(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- assets -------------------------------------------------------------
  app.get(`${BASE}/assets`, requireScope(SCOPES.previewRead), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAssets(ctx, scopeOf(c), { limit: limit ? Number(limit) : undefined });
    return c.json({ items });
  });
  app.post(`${BASE}/assets`, requireScope(SCOPES.contentWrite), async (c) => {
    const created = await createAsset(ctx, blob, scopeOf(c), await c.req.json());
    return c.json(created, 201);
  });
  app.get(`${BASE}/assets/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.post(`${BASE}/assets/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/assets/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await unpublishAsset(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- agent runs / cost ledger (admin) ----------------------------------
  app.get(`${BASE}/agent-runs`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAgentRuns(ctx, scopeOf(c), {
      workflow: c.req.query('workflow'),
      limit: limit ? Number(limit) : undefined,
    });
    return c.json({ items });
  });
  app.get(`${BASE}/agent-runs/usage`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      await agentUsage(ctx, scopeOf(c), {
        workflow: c.req.query('workflow'),
        since: c.req.query('since'),
      }),
    ),
  );

  // --- webhooks (admin) ---------------------------------------------------
  app.get(`${BASE}/webhooks`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: await listWebhooks(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/webhooks`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await createWebhook(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.put(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await updateWebhook(ctx, scopeOf(c), c.req.param('id'), await c.req.json())),
  );
  app.delete(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteWebhook(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  return app;
}

import {
  addComment,
  addEntryToRelease,
  agentUsage,
  auditEntry,
  autoTagAsset,
  autofillField,
  bulkCreateEntries,
  bulkEntryAction,
  cancelScheduledAction,
  canvasToEntry,
  compareEnvironments,
  createAIAction,
  createApiKey,
  createAppExtension,
  createAsset,
  createConcept,
  createContentType,
  createEntry,
  createEnvironment,
  createFunction,
  createRelease,
  createScheme,
  createSpace,
  createTag,
  createTask,
  createWebhook,
  defineWorkflow,
  deleteAIAction,
  deleteAppExtension,
  deleteComment,
  deleteConcept,
  deleteEnvironmentAlias,
  deleteFunction,
  deleteRelease,
  deleteScheme,
  deleteTag,
  deleteTask,
  deleteWebhook,
  deleteWorkflow,
  diffVersions,
  draftEntry,
  findDuplicates,
  generateAltText,
  getAsset,
  getAssetUsage,
  getContentType,
  getEntry,
  getEntryEmbedding,
  getEntryMetadata,
  getEntryWorkflowState,
  getRelease,
  getReverseReferences,
  getSpaceConfig,
  getVersion,
  getWorkflow,
  listAIActions,
  listAgentRuns,
  listApiKeys,
  listAppExtensions,
  listAssets,
  listAuditLog,
  listComments,
  listConcepts,
  listContentTypes,
  listEnvironmentAliases,
  listEnvironments,
  listFunctions,
  listReleases,
  listScheduledActions,
  listSchemes,
  listSpaces,
  listTags,
  listTasks,
  listVersions,
  listWebhookDeliveries,
  listWebhooks,
  listWorkflows,
  mergeEnvironments,
  moderateEntry,
  parseImageTransform,
  publishAsset,
  publishContentType,
  publishEntry,
  publishRelease,
  reassignTask,
  relatedEntries,
  removeEntryFromRelease,
  reopenTask,
  resolveTask,
  restoreVersion,
  revokeApiKey,
  runAIAction,
  scheduleAction,
  setAssetMetadata,
  setConceptBroader,
  setEntryMetadata,
  setEnvironmentAlias,
  suggestEntryTags,
  summarizeEntry,
  transformAssetUrl,
  transitionEntry,
  translateEntry,
  unpublishAsset,
  unpublishEntry,
  updateEntry,
  updateWebhook,
} from '@cw/application';
import { type ApiKey, SCOPES, type Scope, type Webhook } from '@cw/domain';
import { type Context, Hono } from 'hono';
import {
  type AuthDeps,
  type AuthVars,
  auditMiddleware,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../auth.js';

// Reads the route's scope, preferring the alias-resolved environment id stamped
// by environmentMiddleware over the raw `:env` param.
const scopeOf = (c: Context<AuthVars>): Scope => ({
  spaceId: c.req.param('space') as string,
  environmentId: c.get('environmentId') ?? (c.req.param('env') as string),
});

// Public projections that strip secrets before they leave the server: API keys
// never expose their stored hash, webhooks never expose their signing secret.
const apiKeySummary = (k: ApiKey) => ({
  id: k.id,
  kind: k.kind,
  name: k.name,
  scopes: k.scopes,
  revoked: k.revoked,
});
const webhookSummary = (h: Webhook) => ({
  id: h.id,
  url: h.url,
  topics: h.topics,
  active: h.active,
});

const BASE = '/spaces/:space/environments/:env';

/** Management API (CMA): authoring + publishing, gated by RBAC scopes. */
export function managementRoutes(deps: AuthDeps): Hono<AuthVars> {
  const { ctx, hasher, blob, ai, rag, agents } = deps;
  const app = new Hono<AuthVars>();
  app.use('/spaces', principalMiddleware(deps));
  app.use('/spaces/*', principalMiddleware(deps));
  // Resolve environment aliases for any scoped (:env) route.
  app.use('/spaces/:space/environments/:env/*', environmentMiddleware(deps));
  // Record successful mutations to the append-only audit trail.
  app.use('/spaces/:space/*', auditMiddleware(deps));

  // --- provisioning (admin) ----------------------------------------------
  // Authenticated principals see the spaces they can reach: admin → all,
  // a scoped key → just its own. (No requireScope: there is no :space here.)
  app.get('/spaces', async (c) => {
    const principal = c.get('principal');
    if (principal.spaceId === '*') {
      const items = await listSpaces(ctx);
      return c.json({ items: items.map((s) => ({ id: s.spaceId, name: s.name })) });
    }
    const cfg = await ctx.store.spaces.getConfig({
      spaceId: principal.spaceId,
      environmentId: 'main',
    });
    return c.json({ items: cfg ? [{ id: cfg.spaceId, name: cfg.name }] : [] });
  });
  app.post('/spaces', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await c.req.json();
    const created = await createSpace(ctx, body);
    return c.json({ id: created.spaceId, name: created.name }, 201);
  });

  app.get('/spaces/:space/environments', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironments(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/environments', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await c.req.json();
    await createEnvironment(ctx, c.req.param('space'), body.id, body.name);
    return c.json({ id: body.id }, 201);
  });

  // --- environment aliases (blue/green) ----------------------------------
  app.get('/spaces/:space/environment-aliases', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironmentAliases(ctx, c.req.param('space')) }),
  );
  // Create or repoint an alias (atomic cutover).
  app.put(
    '/spaces/:space/environment-aliases/:alias',
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await c.req.json();
      return c.json(
        await setEnvironmentAlias(
          ctx,
          c.req.param('space'),
          c.req.param('alias'),
          body.targetEnvironmentId,
        ),
      );
    },
  );
  app.delete(
    '/spaces/:space/environment-aliases/:alias',
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      await deleteEnvironmentAlias(ctx, c.req.param('space'), c.req.param('alias'));
      return c.body(null, 204);
    },
  );

  // --- audit log (governance, admin) -------------------------------------
  app.get('/spaces/:space/audit-log', requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAuditLog(ctx, c.req.param('space'), {
      environmentId: c.req.query('environment'),
      limit: limit ? Number(limit) : undefined,
    });
    return c.json({ items });
  });

  // --- branch compare/merge (environments) -------------------------------
  app.get('/spaces/:space/compare', requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await compareEnvironments(
        ctx,
        c.req.param('space'),
        c.req.query('source') ?? '',
        c.req.query('target') ?? '',
      ),
    ),
  );
  // Apply selected content types/entries from source→target (additive).
  app.post('/spaces/:space/merge', requireScope(SCOPES.contentManage), async (c) => {
    const body = await c.req.json();
    return c.json(
      await mergeEnvironments(ctx, c.req.param('space'), body.source, body.target, {
        contentTypes: body.contentTypes,
        entries: body.entries,
      }),
    );
  });

  // --- API key management (admin) ----------------------------------------
  app.get('/spaces/:space/api-keys', requireScope(SCOPES.spaceAdmin), async (c) => {
    const keys = await listApiKeys(ctx, c.req.param('space'));
    return c.json({ items: keys.map(apiKeySummary) });
  });
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
  // Canvas: map free-form prose into structured fields (same validation gate).
  app.post(`${BASE}/entries/canvas`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await canvasToEntry(ctx, ai, scopeOf(c), await c.req.json())),
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
  // --- AI content operations over an entry -------------------------------
  app.post(`${BASE}/entries/:id/translate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await translateEntry(ctx, ai, scopeOf(c), c.req.param('id'), await c.req.json())),
  );
  app.post(`${BASE}/entries/:id/summarize`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await summarizeEntry(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/autofill`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await autofillField(ctx, ai, scopeOf(c), c.req.param('id'), await c.req.json())),
  );
  app.post(`${BASE}/entries/:id/suggest-tags`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await suggestEntryTags(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      ),
    ),
  );
  // --- functions (event-triggered, HTTP-invoked) -------------------------
  app.get(`${BASE}/functions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listFunctions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/functions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createFunction(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.delete(`${BASE}/functions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteFunction(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- app extensions (admin UI extensions) ------------------------------
  app.get(`${BASE}/app-extensions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAppExtensions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/app-extensions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createAppExtension(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.delete(`${BASE}/app-extensions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAppExtension(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- bulk operations ---------------------------------------------------
  app.post(`${BASE}/bulk/entries`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await c.req.json();
    return c.json(await bulkCreateEntries(ctx, scopeOf(c), body.items ?? []), 201);
  });
  app.post(`${BASE}/bulk/entries/publish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await c.req.json();
    return c.json(await bulkEntryAction(ctx, scopeOf(c), 'publish', body.ids ?? []));
  });
  app.post(`${BASE}/bulk/entries/unpublish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await c.req.json();
    return c.json(await bulkEntryAction(ctx, scopeOf(c), 'unpublish', body.ids ?? []));
  });

  // --- agent actions (audit → work packages) -----------------------------
  app.post(`${BASE}/entries/:id/audit`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await auditEntry(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      ),
    ),
  );
  // On-demand moderation: classify the entry's text; a flagged result is a
  // recorded hold (`flagged: true`), not a state change — callers decide.
  app.post(`${BASE}/entries/:id/moderate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await moderateEntry(ctx, agents, scopeOf(c), c.req.param('id'))),
  );

  // --- content semantics (vector-backed) ---------------------------------
  app.get(`${BASE}/entries/:id/related`, requireScope(SCOPES.searchRead), async (c) => {
    const topK = c.req.query('top_k');
    return c.json({
      items: await relatedEntries(rag, ctx, scopeOf(c), c.req.param('id'), {
        topK: topK ? Number(topK) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/duplicates`, requireScope(SCOPES.searchRead), async (c) => {
    const threshold = c.req.query('threshold');
    return c.json({
      items: await findDuplicates(rag, ctx, scopeOf(c), c.req.param('id'), {
        threshold: threshold ? Number(threshold) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/embedding`, requireScope(SCOPES.searchRead), async (c) =>
    c.json(
      await getEntryEmbedding(rag, ctx, scopeOf(c), c.req.param('id'), {
        locale: c.req.query('locale'),
      }),
    ),
  );
  app.post(`${BASE}/entries/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishEntry(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/entries/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await unpublishEntry(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- entry version history ---------------------------------------------
  app.get(`${BASE}/entries/:id/versions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listVersions(ctx, scopeOf(c), c.req.param('id')) }),
  );
  // A field-by-field diff between two versions (?from=&to=).
  app.get(`${BASE}/entries/:id/versions/diff`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await diffVersions(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        Number(c.req.query('from')),
        Number(c.req.query('to')),
      ),
    ),
  );
  app.get(`${BASE}/entries/:id/versions/:version`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getVersion(ctx, scopeOf(c), c.req.param('id'), Number(c.req.param('version')))),
  );
  // Restore copies an old version's fields into a NEW draft version.
  app.post(
    `${BASE}/entries/:id/versions/:version/restore`,
    requireScope(SCOPES.contentWrite),
    async (c) =>
      c.json(
        await restoreVersion(ctx, scopeOf(c), c.req.param('id'), Number(c.req.param('version'))),
      ),
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
  app.patch(`${BASE}/assets/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await setAssetMetadata(ctx, scopeOf(c), c.req.param('id'), await c.req.json())),
  );
  app.get(`${BASE}/assets/:id/usage`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await getAssetUsage(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.get(`${BASE}/assets/:id/transform`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      await transformAssetUrl(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        parseImageTransform(c.req.query()),
      ),
    ),
  );
  app.post(`${BASE}/assets/:id/alt-text`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await generateAltText(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      ),
    ),
  );
  app.post(`${BASE}/assets/:id/auto-tag`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await autoTagAsset(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      ),
    ),
  );
  app.post(`${BASE}/assets/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/assets/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await unpublishAsset(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- AI Actions (templated, governed AI operations) --------------------
  app.get(`${BASE}/ai-actions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listAIActions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/ai-actions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createAIAction(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.delete(`${BASE}/ai-actions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAIAction(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/ai-actions/:id/run`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await runAIAction(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await c.req.json().catch(() => ({})),
      ),
    ),
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
  app.get(`${BASE}/webhooks`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const hooks = await listWebhooks(ctx, scopeOf(c));
    return c.json({ items: hooks.map(webhookSummary) });
  });
  app.post(`${BASE}/webhooks`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(webhookSummary(await createWebhook(ctx, scopeOf(c), await c.req.json())), 201),
  );
  app.put(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      webhookSummary(await updateWebhook(ctx, scopeOf(c), c.req.param('id'), await c.req.json())),
    ),
  );
  app.delete(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteWebhook(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/webhooks/:id/deliveries`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listWebhookDeliveries(ctx, scopeOf(c), c.req.param('id'), {
      limit: limit ? Number(limit) : undefined,
    });
    return c.json({ items });
  });

  // --- releases -----------------------------------------------------------
  // Bundle entries and ship them atomically. Authoring (create/add/remove) is a
  // write; shipping the bundle requires publish.
  app.get(`${BASE}/releases`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listReleases(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/releases`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await createRelease(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.get(`${BASE}/releases/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getRelease(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/releases/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteRelease(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/releases/:id/items`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await addEntryToRelease(ctx, scopeOf(c), c.req.param('id'), await c.req.json())),
  );
  app.delete(`${BASE}/releases/:id/items/:entityId`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await removeEntryFromRelease(ctx, scopeOf(c), c.req.param('id'), c.req.param('entityId')),
    ),
  );
  app.post(`${BASE}/releases/:id/published`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await publishRelease(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- scheduled actions --------------------------------------------------
  app.get(`${BASE}/scheduled-actions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({
      items: await listScheduledActions(ctx, scopeOf(c), { status: c.req.query('status') }),
    }),
  );
  app.post(`${BASE}/scheduled-actions`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await scheduleAction(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.delete(`${BASE}/scheduled-actions/:id`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await cancelScheduledAction(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- comments (on entries) ---------------------------------------------
  app.get(`${BASE}/entries/:id/comments`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listComments(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.post(`${BASE}/entries/:id/comments`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await c.req.json();
    const created = await addComment(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      author: body.author ?? c.get('principal').kind,
      parentId: body.parentId,
    });
    return c.json(created, 201);
  });
  app.delete(`${BASE}/comments/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteComment(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- tasks (on entries) ------------------------------------------------
  app.get(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listTasks(ctx, scopeOf(c), c.req.param('id')) }),
  );
  app.post(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await c.req.json();
    const created = await createTask(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      assignee: body.assignee,
    });
    return c.json(created, 201);
  });
  // PUT applies one change: resolve/reopen (status) or reassign (assignee).
  app.put(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await c.req.json();
    const id = c.req.param('id');
    const scope = scopeOf(c);
    if (body.status === 'resolved') return c.json(await resolveTask(ctx, scope, id));
    if (body.status === 'open') return c.json(await reopenTask(ctx, scope, id));
    if ('assignee' in body)
      return c.json(await reassignTask(ctx, scope, id, body.assignee ?? null));
    return c.json({ error: 'Provide status or assignee' }, 400);
  });
  app.delete(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteTask(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- workflows ---------------------------------------------------------
  app.get(`${BASE}/workflows`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listWorkflows(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/workflows`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await defineWorkflow(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.get(`${BASE}/workflows/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getWorkflow(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/workflows/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteWorkflow(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/entries/:id/workflow`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getEntryWorkflowState(ctx, scopeOf(c), c.req.param('id'))),
  );
  // The transition's required scope is data-driven by the target step, so the
  // base guard is only previewRead; transitionEntry enforces the step's scope.
  app.post(
    `${BASE}/entries/:id/workflow/transition`,
    requireScope(SCOPES.previewRead),
    async (c) => {
      const body = await c.req.json();
      return c.json(
        await transitionEntry(
          ctx,
          scopeOf(c),
          { entryId: c.req.param('id'), workflowId: body.workflowId, toStepId: body.toStepId },
          c.get('principal').scopes,
        ),
      );
    },
  );

  // --- taxonomy (controlled vocabulary) ----------------------------------
  app.get(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listSchemes(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/schemes`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createScheme(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.delete(`${BASE}/taxonomy/schemes/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteScheme(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listConcepts(ctx, scopeOf(c), c.req.query('scheme')) }),
  );
  app.post(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createConcept(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.put(
    `${BASE}/taxonomy/concepts/:id/broader`,
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await c.req.json();
      return c.json(
        await setConceptBroader(ctx, scopeOf(c), c.req.param('id'), body.broaderId ?? null),
      );
    },
  );
  app.delete(`${BASE}/taxonomy/concepts/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteConcept(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/tags`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listTags(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/taxonomy/tags`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createTag(ctx, scopeOf(c), await c.req.json()), 201),
  );
  app.delete(`${BASE}/taxonomy/tags/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteTag(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- entry taxonomy associations ---------------------------------------
  app.get(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(
      (await getEntryMetadata(ctx, scopeOf(c), c.req.param('id'))) ?? { tags: [], concepts: [] },
    ),
  );
  app.put(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await setEntryMetadata(ctx, scopeOf(c), c.req.param('id'), await c.req.json())),
  );

  return app;
}

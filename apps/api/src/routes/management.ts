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
  createPreviewLink,
  createRelease,
  createRole,
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
  deleteRole,
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
  getRole,
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
  listRoles,
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
  requestReindex,
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
  updateRole,
  updateWebhook,
} from '@cw/application';
import {
  type ApiKey,
  type ContentAction,
  SCOPES,
  type Scope,
  ValidationError,
  type Webhook,
  assertWritableFields,
  authorizeContent,
  maskDeniedFields,
} from '@cw/domain';
import { type Context, Hono } from 'hono';
import {
  type AuthDeps,
  type AuthVars,
  auditMiddleware,
  environmentMiddleware,
  principalMiddleware,
  requireScope,
} from '../auth.js';
import { doc } from '../docs/openapi.js';
import * as docs from '../docs/schemas.js';
import { MAX_PAGE_LIMIT, clampCount } from '../query.js';
import {
  altTextBody,
  appExtensionBody,
  assetMetadataBody,
  auditBody,
  autofillBody,
  broaderBody,
  bulkEntriesBody,
  canvasBody,
  commentBody,
  conceptBody,
  contentTypeBody,
  createAiActionBody,
  createApiKeyBody,
  createAssetBody,
  createEntryBody,
  createEnvironmentBody,
  createFunctionBody,
  createReleaseBody,
  createSpaceBody,
  createTaskBody,
  draftEntryBody,
  entryMetadataBody,
  idsBody,
  mergeBody,
  parseBody,
  previewLinkBody,
  reindexBody,
  releaseItemBody,
  roleBody,
  runAiActionBody,
  scheduleBody,
  schemeBody,
  setAliasBody,
  summarizeBody,
  tagBody,
  tierOnlyBody,
  transitionBody,
  translateBody,
  updateEntryBody,
  updateTaskBody,
  updateWebhookBody,
  webhookBody,
  workflowBody,
} from '../validation.js';

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
  roleId: k.roleId,
  lastUsedAt: k.lastUsedAt,
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

  /** Lightweight principal probe for admin connection UI and SSO sessions. */
  app.get(
    '/auth/me',
    doc('Auth', 'Resolve the calling principal', { ok: docs.principal }),
    principalMiddleware(deps),
    (c) => {
      const principal = c.get('principal');
      return c.json({
        spaceId: principal.spaceId,
        kind: principal.kind,
        scopes: principal.scopes,
        subject: principal.subject,
        restricted: principal.contentGrants !== undefined,
      });
    },
  );

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
  app.post(
    '/spaces',
    doc('Spaces & environments', 'Create a space (admin token)', {
      ok: docs.spaceRef,
      status: 201,
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createSpaceBody);
      const created = await createSpace(ctx, body);
      return c.json({ id: created.spaceId, name: created.name }, 201);
    },
  );

  app.get('/spaces/:space/environments', requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listEnvironments(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/environments', requireScope(SCOPES.spaceAdmin), async (c) => {
    const body = await parseBody(c, createEnvironmentBody);
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
      const body = await parseBody(c, setAliasBody);
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
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
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
    const body = await parseBody(c, mergeBody);
    return c.json(
      await mergeEnvironments(ctx, c.req.param('space'), body.source, body.target, {
        contentTypes: body.contentTypes,
        entries: body.entries,
      }),
    );
  });

  // --- API key management (admin) ----------------------------------------
  app.get(
    '/spaces/:space/api-keys',
    doc('Auth', 'List API keys for a space'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const keys = await listApiKeys(ctx, c.req.param('space'));
      return c.json({ items: keys.map(apiKeySummary) });
    },
  );
  app.post(
    '/spaces/:space/api-keys',
    doc('Auth', 'Mint an API key', {
      ok: docs.apiKeyCreated,
      status: 201,
      description: 'The raw token is returned once; only its SHA-256 hash is stored.',
    }),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const body = await parseBody(c, createApiKeyBody);
      // spaceId is taken ONLY from the authorized route param, so a caller-supplied
      // `spaceId` can never rebind the key to another tenant (the schema strips
      // unknown keys, so it never reaches here regardless).
      const created = await createApiKey(ctx, hasher, {
        spaceId: c.req.param('space'),
        kind: body.kind,
        name: body.name,
        scopes: body.scopes,
        roleId: body.roleId,
      });
      // Return the raw token once; only its hash is stored.
      return c.json(
        { id: created.apiKey.id, kind: created.apiKey.kind, token: created.token },
        201,
      );
    },
  );
  app.delete('/spaces/:space/api-keys/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await revokeApiKey(ctx, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- roles (granular RBAC, admin) ----------------------------------------
  app.get('/spaces/:space/roles', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json({ items: await listRoles(ctx, c.req.param('space')) }),
  );
  app.post('/spaces/:space/roles', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await createRole(ctx, c.req.param('space'), await parseBody(c, roleBody)), 201),
  );
  app.get('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(await getRole(ctx, c.req.param('space'), c.req.param('id'))),
  );
  app.put('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      await updateRole(ctx, c.req.param('space'), c.req.param('id'), await parseBody(c, roleBody)),
    ),
  );
  app.delete('/spaces/:space/roles/:id', requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteRole(ctx, c.req.param('space'), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- space config (locales) --------------------------------------------
  app.get(`${BASE}/space-config`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getSpaceConfig(ctx, scopeOf(c))),
  );

  // --- content types ------------------------------------------------------
  app.get(
    `${BASE}/content-types`,
    doc('Content types', 'List content types'),
    requireScope(SCOPES.previewRead),
    async (c) => c.json({ items: await listContentTypes(ctx, scopeOf(c)) }),
  );
  app.post(
    `${BASE}/content-types`,
    doc('Content types', 'Create a content type', { ok: docs.contentType, status: 201 }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const ct = await createContentType(
        ctx,
        scopeOf(c),
        (await parseBody(c, contentTypeBody)) as unknown as Parameters<typeof createContentType>[2],
      );
      return c.json(ct, 201);
    },
  );
  app.get(
    `${BASE}/content-types/:apiId`,
    doc('Content types', 'Get a content type', { ok: docs.contentType }),
    requireScope(SCOPES.previewRead),
    async (c) => c.json(await getContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );
  app.post(
    `${BASE}/content-types/:apiId/published`,
    requireScope(SCOPES.contentPublish),
    async (c) => c.json(await publishContentType(ctx, scopeOf(c), c.req.param('apiId'))),
  );

  // --- entries ------------------------------------------------------------
  // Granular RBAC: content-level check on top of the coarse scope for
  // role-bound principals (unrestricted principals short-circuit inside the
  // domain helpers). Resolves the entry's content type when needed.
  const guardEntry = async (c: Context<AuthVars>, id: string, action: ContentAction) => {
    const principal = c.get('principal');
    if (!principal.contentGrants) return;
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeContent(principal, action, entry.contentTypeApiId);
  };

  // Authorizes read on an entry (404 if missing, 403 if the role can't read its
  // content type) and returns the content type id so callers can mask denied
  // fields on version/history/related reads. Use this on every path that returns
  // an entry's field values so granular RBAC can't be bypassed via a side door.
  const authorizeEntryRead = async (c: Context<AuthVars>, id: string): Promise<string> => {
    const { entry } = await getEntry(ctx, scopeOf(c), id);
    authorizeContent(c.get('principal'), 'read', entry.contentTypeApiId);
    return entry.contentTypeApiId;
  };

  app.post(
    `${BASE}/entries`,
    doc('Entries', 'Create a draft entry', { ok: docs.createdEntry, status: 201 }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, createEntryBody);
      const principal = c.get('principal');
      authorizeContent(principal, 'write', body.contentTypeApiId);
      assertWritableFields(principal, body.contentTypeApiId, body.fields ?? {});
      const view = await createEntry(ctx, scopeOf(c), body as Parameters<typeof createEntry>[2]);
      return c.json(view, 201);
    },
  );
  // AI-draft an entry's fields. Generated values pass the same validators a
  // human write does, so an agent can't produce an entry a person couldn't.
  app.post(`${BASE}/entries/generate`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, draftEntryBody);
    authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
    return c.json(await draftEntry(ctx, ai, scopeOf(c), body));
  });
  // Canvas: map free-form prose into structured fields (same validation gate).
  app.post(`${BASE}/entries/canvas`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, canvasBody);
    authorizeContent(c.get('principal'), 'write', body.contentTypeApiId);
    return c.json(await canvasToEntry(ctx, ai, scopeOf(c), body));
  });
  app.get(
    `${BASE}/entries/:id`,
    doc('Entries', 'Get an entry (draft state)', { ok: docs.entry }),
    requireScope(SCOPES.previewRead),
    async (c) => {
      const view = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      const principal = c.get('principal');
      authorizeContent(principal, 'read', view.entry.contentTypeApiId);
      return c.json({
        ...view,
        fields: maskDeniedFields(principal, view.entry.contentTypeApiId, view.fields),
      });
    },
  );
  app.post(`${BASE}/entries/:id/preview-link`, requireScope(SCOPES.contentWrite), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const body = await parseBody(c, previewLinkBody);
    const origin = c.req.header('origin') ?? '';
    const link = await createPreviewLink(ctx, hasher, scopeOf(c), c.req.param('id'), {
      ttlHours: body.ttlHours,
      previewBaseUrl: body.previewBaseUrl ?? origin,
    });
    return c.json(link, 201);
  });
  // "What links here": entries/assets that reference this entry.
  app.get(`${BASE}/entries/:id/reverse-references`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await getReverseReferences(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.put(
    `${BASE}/entries/:id`,
    doc('Entries', 'Save a new draft version', { ok: docs.entry }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const body = await parseBody(c, updateEntryBody);
      const principal = c.get('principal');
      if (principal.contentGrants) {
        const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
        authorizeContent(principal, 'write', entry.contentTypeApiId);
        assertWritableFields(principal, entry.contentTypeApiId, body.fields ?? {});
      }
      return c.json(await updateEntry(ctx, scopeOf(c), c.req.param('id'), body.fields));
    },
  );
  // --- AI content operations over an entry -------------------------------
  app.post(`${BASE}/entries/:id/translate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await translateEntry(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, translateBody),
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/summarize`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await summarizeEntry(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, summarizeBody),
      ),
    ),
  );
  app.post(`${BASE}/entries/:id/autofill`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await autofillField(ctx, ai, scopeOf(c), c.req.param('id'), await parseBody(c, autofillBody)),
    ),
  );
  app.post(`${BASE}/entries/:id/suggest-tags`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await suggestEntryTags(
        ctx,
        ai,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, tierOnlyBody),
      ),
    ),
  );
  // --- functions (event-triggered, HTTP-invoked) -------------------------
  app.get(`${BASE}/functions`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listFunctions(ctx, scopeOf(c)) }),
  );
  app.post(`${BASE}/functions`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createFunction(ctx, scopeOf(c), await parseBody(c, createFunctionBody)), 201),
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
    c.json(await createAppExtension(ctx, scopeOf(c), await parseBody(c, appExtensionBody)), 201),
  );
  app.delete(`${BASE}/app-extensions/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteAppExtension(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- bulk operations ---------------------------------------------------
  app.post(`${BASE}/bulk/entries`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, bulkEntriesBody);
    const principal = c.get('principal');
    for (const item of body.items ?? []) {
      authorizeContent(principal, 'write', item.contentTypeApiId);
      assertWritableFields(principal, item.contentTypeApiId, item.fields ?? {});
    }
    return c.json(
      await bulkCreateEntries(
        ctx,
        scopeOf(c),
        (body.items ?? []) as Parameters<typeof bulkCreateEntries>[2],
      ),
      201,
    );
  });
  app.post(`${BASE}/bulk/entries/publish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, idsBody);
    for (const id of body.ids ?? []) await guardEntry(c, id, 'publish');
    return c.json(await bulkEntryAction(ctx, scopeOf(c), 'publish', body.ids ?? []));
  });
  app.post(`${BASE}/bulk/entries/unpublish`, requireScope(SCOPES.contentPublish), async (c) => {
    const body = await parseBody(c, idsBody);
    for (const id of body.ids ?? []) await guardEntry(c, id, 'publish');
    return c.json(await bulkEntryAction(ctx, scopeOf(c), 'unpublish', body.ids ?? []));
  });

  // --- agent actions (audit → work packages) -----------------------------
  app.post(`${BASE}/entries/:id/audit`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await auditEntry(ctx, ai, scopeOf(c), c.req.param('id'), await parseBody(c, auditBody))),
  );
  // On-demand moderation: classify the entry's text; a flagged result is a
  // recorded hold (`flagged: true`), not a state change — callers decide.
  app.post(`${BASE}/entries/:id/moderate`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(await moderateEntry(ctx, agents, scopeOf(c), c.req.param('id'))),
  );

  // --- content semantics (vector-backed) ---------------------------------
  app.get(`${BASE}/entries/:id/related`, requireScope(SCOPES.searchRead), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
    const topK = c.req.query('top_k');
    return c.json({
      items: await relatedEntries(rag, ctx, scopeOf(c), c.req.param('id'), {
        topK: topK ? Number(topK) : undefined,
        locale: c.req.query('locale'),
      }),
    });
  });
  app.get(`${BASE}/entries/:id/duplicates`, requireScope(SCOPES.searchRead), async (c) => {
    await guardEntry(c, c.req.param('id'), 'read');
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
  // Bulk re-embed the scope's published entries (e.g. after an extraction or
  // embedding-model change). Idempotent per entry; safe to re-run.
  app.post(
    `${BASE}/search/reindex`,
    doc('AI & agents', 'Request a reindex of all published entries', {
      status: 202,
      description:
        'Enqueues a background reindex (via the outbox → queue) that re-embeds every ' +
        'published entry in the environment (optionally one content type). Returns 202; ' +
        'the work runs on the worker. Rate-limited per scope (429 if requested too soon).',
    }),
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, reindexBody);
      const result = await requestReindex(ctx, scopeOf(c), {
        contentTypeApiId: body.contentTypeApiId,
      });
      return c.json(result, 202);
    },
  );
  app.post(
    `${BASE}/entries/:id/published`,
    doc('Entries', 'Publish an entry', {
      ok: docs.entry,
      description:
        'Writes the delivery read model and appends entry.published to the transactional outbox atomically.',
    }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      const id = c.req.param('id');
      await guardEntry(c, id, 'publish');
      // Optional synchronous pre-publish moderation gate: reject flagged content
      // before it ever reaches the delivery read model.
      if (deps.moderateBeforePublish) {
        const verdict = await moderateEntry(ctx, agents, scopeOf(c), id);
        if (verdict.flagged) {
          throw new ValidationError([
            {
              field: 'moderation',
              message: `Publish blocked by moderation: ${verdict.decisions.join('; ') || 'policy violation'}`,
            },
          ]);
        }
      }
      return c.json(await publishEntry(ctx, scopeOf(c), id));
    },
  );
  app.delete(
    `${BASE}/entries/:id/published`,
    doc('Entries', 'Unpublish an entry', { ok: docs.entry }),
    requireScope(SCOPES.contentPublish),
    async (c) => {
      await guardEntry(c, c.req.param('id'), 'publish');
      return c.json(await unpublishEntry(ctx, scopeOf(c), c.req.param('id')));
    },
  );

  // --- entry version history ---------------------------------------------
  // Version snapshots carry raw field values, so every read authorizes the
  // entry's content type and masks denied fields — matching GET /entries/:id.
  app.get(`${BASE}/entries/:id/versions`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const items = (await listVersions(ctx, scopeOf(c), c.req.param('id'))).map((v) => ({
      ...v,
      fields: maskDeniedFields(principal, type, v.fields),
    }));
    return c.json({ items });
  });
  // A field-by-field diff between two versions (?from=&to=).
  app.get(`${BASE}/entries/:id/versions/diff`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const principal = c.get('principal');
    const diff = await diffVersions(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.query('from')),
      Number(c.req.query('to')),
    );
    // Drop denied fields from the diff so they can't leak via before/after.
    const allowed = maskDeniedFields(
      principal,
      type,
      Object.fromEntries(diff.changes.map((ch) => [ch.field, ch])),
    );
    return c.json({ ...diff, changes: Object.values(allowed) });
  });
  app.get(`${BASE}/entries/:id/versions/:version`, requireScope(SCOPES.previewRead), async (c) => {
    const type = await authorizeEntryRead(c, c.req.param('id'));
    const version = await getVersion(
      ctx,
      scopeOf(c),
      c.req.param('id'),
      Number(c.req.param('version')),
    );
    return c.json({
      ...version,
      fields: maskDeniedFields(c.get('principal'), type, version.fields),
    });
  });
  // Restore copies an old version's fields into a NEW draft version. It must pass
  // the same write authorization as a normal edit, so a role with denied/
  // read-only fields can't resurrect them by restoring, or write an ungranted type.
  app.post(
    `${BASE}/entries/:id/versions/:version/restore`,
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const principal = c.get('principal');
      const { entry } = await getEntry(ctx, scopeOf(c), c.req.param('id'));
      authorizeContent(principal, 'write', entry.contentTypeApiId);
      const target = await getVersion(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        Number(c.req.param('version')),
      );
      assertWritableFields(principal, entry.contentTypeApiId, target.fields);
      return c.json(
        await restoreVersion(ctx, scopeOf(c), c.req.param('id'), Number(c.req.param('version'))),
      );
    },
  );

  // --- assets -------------------------------------------------------------
  app.get(`${BASE}/assets`, requireScope(SCOPES.previewRead), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAssets(ctx, scopeOf(c), {
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
    });
    return c.json({ items });
  });
  app.post(
    `${BASE}/assets`,
    doc('Assets', 'Create an asset (presigned direct upload)', {
      ok: docs.uploadTicket,
      status: 201,
      description: 'PUT the file bytes to upload.url with upload.headers, then publish the asset.',
    }),
    requireScope(SCOPES.contentWrite),
    async (c) => {
      const created = await createAsset(ctx, blob, scopeOf(c), await parseBody(c, createAssetBody));
      return c.json(created, 201);
    },
  );
  app.get(`${BASE}/assets/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getAsset(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.patch(`${BASE}/assets/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await setAssetMetadata(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, assetMetadataBody),
      ),
    ),
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
        await parseBody(c, altTextBody),
      ),
    ),
  );
  app.post(`${BASE}/assets/:id/auto-tag`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await autoTagAsset(ctx, ai, scopeOf(c), c.req.param('id'), await parseBody(c, tierOnlyBody)),
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
    c.json(await createAIAction(ctx, scopeOf(c), await parseBody(c, createAiActionBody)), 201),
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
        await parseBody(c, runAiActionBody),
      ),
    ),
  );

  // --- agent runs / cost ledger (admin) ----------------------------------
  app.get(`${BASE}/agent-runs`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listAgentRuns(ctx, scopeOf(c), {
      workflow: c.req.query('workflow'),
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
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
  app.get(
    `${BASE}/webhooks`,
    doc('Webhooks', 'List webhooks'),
    requireScope(SCOPES.spaceAdmin),
    async (c) => {
      const hooks = await listWebhooks(ctx, scopeOf(c));
      return c.json({ items: hooks.map(webhookSummary) });
    },
  );
  app.post(`${BASE}/webhooks`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      webhookSummary(
        await createWebhook(
          ctx,
          scopeOf(c),
          (await parseBody(c, webhookBody)) as Parameters<typeof createWebhook>[2],
        ),
      ),
      201,
    ),
  );
  app.put(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) =>
    c.json(
      webhookSummary(
        await updateWebhook(
          ctx,
          scopeOf(c),
          c.req.param('id'),
          (await parseBody(c, updateWebhookBody)) as Parameters<typeof updateWebhook>[3],
        ),
      ),
    ),
  );
  app.delete(`${BASE}/webhooks/:id`, requireScope(SCOPES.spaceAdmin), async (c) => {
    await deleteWebhook(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/webhooks/:id/deliveries`, requireScope(SCOPES.spaceAdmin), async (c) => {
    const limit = c.req.query('limit');
    const items = await listWebhookDeliveries(ctx, scopeOf(c), c.req.param('id'), {
      limit: clampCount(limit, MAX_PAGE_LIMIT, { min: 1 }),
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
    c.json(await createRelease(ctx, scopeOf(c), await parseBody(c, createReleaseBody)), 201),
  );
  app.get(`${BASE}/releases/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getRelease(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/releases/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    await deleteRelease(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.post(`${BASE}/releases/:id/items`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await addEntryToRelease(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, releaseItemBody),
      ),
    ),
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
    c.json(
      await scheduleAction(
        ctx,
        scopeOf(c),
        (await parseBody(c, scheduleBody)) as unknown as Parameters<typeof scheduleAction>[2],
      ),
      201,
    ),
  );
  app.delete(`${BASE}/scheduled-actions/:id`, requireScope(SCOPES.contentPublish), async (c) =>
    c.json(await cancelScheduledAction(ctx, scopeOf(c), c.req.param('id'))),
  );

  // --- comments (on entries) ---------------------------------------------
  app.get(`${BASE}/entries/:id/comments`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await listComments(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.post(`${BASE}/entries/:id/comments`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, commentBody);
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
  app.get(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json({ items: await listTasks(ctx, scopeOf(c), c.req.param('id')) });
  });
  app.post(`${BASE}/entries/:id/tasks`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, createTaskBody);
    const created = await createTask(ctx, scopeOf(c), {
      entryId: c.req.param('id'),
      body: body.body,
      assignee: body.assignee,
    });
    return c.json(created, 201);
  });
  // PUT applies one change: resolve/reopen (status) or reassign (assignee).
  app.put(`${BASE}/tasks/:id`, requireScope(SCOPES.contentWrite), async (c) => {
    const body = await parseBody(c, updateTaskBody);
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
    c.json(
      await defineWorkflow(
        ctx,
        scopeOf(c),
        (await parseBody(c, workflowBody)) as Parameters<typeof defineWorkflow>[2],
      ),
      201,
    ),
  );
  app.get(`${BASE}/workflows/:id`, requireScope(SCOPES.previewRead), async (c) =>
    c.json(await getWorkflow(ctx, scopeOf(c), c.req.param('id'))),
  );
  app.delete(`${BASE}/workflows/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteWorkflow(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });
  app.get(`${BASE}/entries/:id/workflow`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json(await getEntryWorkflowState(ctx, scopeOf(c), c.req.param('id')));
  });
  // The transition's required scope is data-driven by the target step, so the
  // base guard is only previewRead; transitionEntry enforces the step's scope.
  app.post(
    `${BASE}/entries/:id/workflow/transition`,
    requireScope(SCOPES.previewRead),
    async (c) => {
      const body = await parseBody(c, transitionBody);
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
    c.json(await createScheme(ctx, scopeOf(c), await parseBody(c, schemeBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/schemes/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteScheme(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  app.get(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.previewRead), async (c) =>
    c.json({ items: await listConcepts(ctx, scopeOf(c), c.req.query('scheme')) }),
  );
  app.post(`${BASE}/taxonomy/concepts`, requireScope(SCOPES.contentManage), async (c) =>
    c.json(await createConcept(ctx, scopeOf(c), await parseBody(c, conceptBody)), 201),
  );
  app.put(
    `${BASE}/taxonomy/concepts/:id/broader`,
    requireScope(SCOPES.contentManage),
    async (c) => {
      const body = await parseBody(c, broaderBody);
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
    c.json(await createTag(ctx, scopeOf(c), await parseBody(c, tagBody)), 201),
  );
  app.delete(`${BASE}/taxonomy/tags/:id`, requireScope(SCOPES.contentManage), async (c) => {
    await deleteTag(ctx, scopeOf(c), c.req.param('id'));
    return c.body(null, 204);
  });

  // --- entry taxonomy associations ---------------------------------------
  app.get(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.previewRead), async (c) => {
    await authorizeEntryRead(c, c.req.param('id'));
    return c.json(
      (await getEntryMetadata(ctx, scopeOf(c), c.req.param('id'))) ?? { tags: [], concepts: [] },
    );
  });
  app.put(`${BASE}/entries/:id/metadata`, requireScope(SCOPES.contentWrite), async (c) =>
    c.json(
      await setEntryMetadata(
        ctx,
        scopeOf(c),
        c.req.param('id'),
        await parseBody(c, entryMetadataBody),
      ),
    ),
  );

  return app;
}

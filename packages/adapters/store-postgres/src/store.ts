import {
  type ApiKey,
  type Asset,
  type Comment,
  type Concept,
  type ContentType,
  type DomainEvent,
  type Entry,
  type EntryMetadata,
  type EntryVersion,
  type ReferenceEdge,
  type Release,
  type ScheduledAction,
  type Scope,
  type Task,
  type Webhook,
  type WorkflowDefinition,
  type WorkflowStep,
  matchesTopic,
  projectFields,
  runEntryQuery,
} from '@cw/domain';
import type {
  AgentRunRecord,
  AgentRunRepo,
  AssetRepo,
  AuditRepo,
  AuthRepo,
  CommentRepo,
  ContentStore,
  ContentStoreTx,
  ContentTypeRepo,
  EntryQuery,
  EntryRepo,
  EntryWithFields,
  OutboxRepo,
  PublishedAsset,
  PublishedEntry,
  ReferenceRepo,
  ReleaseRepo,
  ScheduledActionRepo,
  ScopedScheduledAction,
  SpaceRepo,
  TaskRepo,
  TaxonomyRepo,
  WebhookRepo,
  WorkflowRepo,
} from '@cw/ports';
import { and, asc, count, desc, eq, gt, gte, isNull, lte, sum } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

type Db = PostgresJsDatabase<typeof schema>;

const scopeFilter = (t: { spaceId: unknown; environmentId: unknown }, scope: Scope) =>
  and(eq(t.spaceId as never, scope.spaceId), eq(t.environmentId as never, scope.environmentId));

// Field-level filtering/ordering/search/projection runs in JS over the loaded
// rows (shared with the in-memory store for identical semantics). When any of
// these are present we cannot push `limit/offset` into SQL, so the scoped set is
// loaded in full and paginated in JS. Pushing JSONB predicates down to SQL is a
// future optimization. The common `contentType + since + limit/skip` path keeps
// its SQL pushdown.
const isAdvancedQuery = (q: EntryQuery) =>
  Boolean(q.filters?.length || q.order?.length || q.search || q.select);

function makeContentTypeRepo(db: Db): ContentTypeRepo {
  return {
    async get(scope, apiId) {
      const [row] = await db
        .select()
        .from(schema.contentTypes)
        .where(and(scopeFilter(schema.contentTypes, scope), eq(schema.contentTypes.apiId, apiId)));
      return row ? toContentType(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.contentTypes)
        .where(scopeFilter(schema.contentTypes, scope));
      return rows.map(toContentType);
    },
    async save(scope, ct) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        apiId: ct.apiId,
        name: ct.name,
        displayField: ct.displayField,
        fields: [...ct.fields],
        version: ct.version,
        status: ct.status,
        updatedAt: new Date(),
      };
      await db
        .insert(schema.contentTypes)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.contentTypes.spaceId,
            schema.contentTypes.environmentId,
            schema.contentTypes.apiId,
          ],
          set: {
            name: values.name,
            displayField: values.displayField,
            fields: values.fields,
            version: values.version,
            status: values.status,
            updatedAt: values.updatedAt,
          },
        });
    },
  };
}

function makeEntryRepo(db: Db): EntryRepo {
  return {
    async get(scope, id) {
      const [entry] = await db
        .select()
        .from(schema.entries)
        .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, id)));
      if (!entry) return null;
      const [version] = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(
            scopeFilter(schema.entryVersions, scope),
            eq(schema.entryVersions.entryId, id),
            eq(schema.entryVersions.version, entry.currentVersion),
          ),
        );
      const result: EntryWithFields = { entry: toEntry(entry), fields: version?.fields ?? {} };
      return result;
    },
    async list(scope, query: EntryQuery) {
      const advanced = isAdvancedQuery(query);
      const conditions = [scopeFilter(schema.entries, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entries.contentTypeApiId, query.contentTypeApiId));
      }
      let select = db
        .select()
        .from(schema.entries)
        .where(and(...conditions))
        .orderBy(asc(schema.entries.updatedAt))
        .$dynamic();
      // SQL pagination is only valid when there are no JS-side field predicates.
      if (!advanced) select = select.limit(query.limit ?? 100).offset(query.skip ?? 0);
      const rows = await select;
      // Fetch each entry's current-version fields.
      const results: EntryWithFields[] = [];
      for (const row of rows) {
        const [version] = await db
          .select()
          .from(schema.entryVersions)
          .where(
            and(
              scopeFilter(schema.entryVersions, scope),
              eq(schema.entryVersions.entryId, row.id),
              eq(schema.entryVersions.version, row.currentVersion),
            ),
          );
        results.push({ entry: toEntry(row), fields: version?.fields ?? {} });
      }
      if (!advanced) return results;
      const filtered = runEntryQuery(
        results,
        query,
        (r) => r.fields,
        (r) => ({ id: r.entry.id, contentType: r.entry.contentTypeApiId, status: r.entry.status }),
      );
      if (!query.select) return filtered;
      return filtered.map((r) => ({
        ...r,
        fields: projectFields(r.fields, query.select as string[]),
      }));
    },
    async create(scope, entry, version) {
      await db.insert(schema.entries).values(entryRow(scope, entry));
      await db.insert(schema.entryVersions).values(versionRow(scope, version));
    },
    async saveVersion(scope, entry, version) {
      await db.insert(schema.entryVersions).values(versionRow(scope, version));
      await saveEntryAggregate(db, scope, entry);
    },
    async saveAggregate(scope, entry) {
      await saveEntryAggregate(db, scope, entry);
    },
    async listVersions(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(scopeFilter(schema.entryVersions, scope), eq(schema.entryVersions.entryId, entryId)),
        )
        .orderBy(desc(schema.entryVersions.version));
      return rows.map(toVersion);
    },
    async getVersion(scope, entryId, version) {
      const [row] = await db
        .select()
        .from(schema.entryVersions)
        .where(
          and(
            scopeFilter(schema.entryVersions, scope),
            eq(schema.entryVersions.entryId, entryId),
            eq(schema.entryVersions.version, version),
          ),
        );
      return row ? toVersion(row) : null;
    },
    async putPublished(scope, snapshot) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId: snapshot.entryId,
        contentTypeApiId: snapshot.contentTypeApiId,
        version: snapshot.version,
        fields: snapshot.fields,
        metadata: snapshot.metadata
          ? { tags: [...snapshot.metadata.tags], concepts: [...snapshot.metadata.concepts] }
          : null,
        publishedAt: new Date(snapshot.publishedAt),
      };
      await db
        .insert(schema.entryPublished)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.entryPublished.spaceId,
            schema.entryPublished.environmentId,
            schema.entryPublished.entryId,
          ],
          set: {
            contentTypeApiId: values.contentTypeApiId,
            version: values.version,
            fields: values.fields,
            metadata: values.metadata,
            publishedAt: values.publishedAt,
          },
        });
    },
    async removePublished(scope, entryId) {
      await db
        .delete(schema.entryPublished)
        .where(
          and(
            scopeFilter(schema.entryPublished, scope),
            eq(schema.entryPublished.entryId, entryId),
          ),
        );
    },
    async getPublished(scope, id) {
      const [row] = await db
        .select()
        .from(schema.entryPublished)
        .where(
          and(scopeFilter(schema.entryPublished, scope), eq(schema.entryPublished.entryId, id)),
        );
      return row ? toPublished(row) : null;
    },
    async listPublished(scope, query: EntryQuery) {
      const advanced = isAdvancedQuery(query);
      const conditions = [scopeFilter(schema.entryPublished, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entryPublished.contentTypeApiId, query.contentTypeApiId));
      }
      if (query.since)
        conditions.push(gt(schema.entryPublished.publishedAt, new Date(query.since)));
      let select = db
        .select()
        .from(schema.entryPublished)
        .where(and(...conditions))
        .orderBy(asc(schema.entryPublished.publishedAt))
        .$dynamic();
      if (!advanced) select = select.limit(query.limit ?? 100).offset(query.skip ?? 0);
      const published = (await select).map(toPublished);
      if (!advanced) return published;
      const filtered = runEntryQuery(
        published,
        query,
        (r) => r.fields,
        (r) => ({
          id: r.entryId,
          contentType: r.contentTypeApiId,
          publishedAt: r.publishedAt,
          'metadata.tags': r.metadata?.tags ?? [],
          'metadata.concepts': r.metadata?.concepts ?? [],
        }),
      );
      if (!query.select) return filtered;
      return filtered.map((r) => ({
        ...r,
        fields: projectFields(r.fields, query.select as string[]),
      }));
    },
  };
}

function makeAssetRepo(db: Db): AssetRepo {
  const upsertDraft = async (scope: Scope, asset: Asset) => {
    const values = {
      spaceId: scope.spaceId,
      environmentId: scope.environmentId,
      id: asset.id,
      status: asset.status,
      file: asset.file,
      title: asset.title,
      description: asset.description,
      updatedAt: new Date(),
    };
    await db
      .insert(schema.assets)
      .values(values)
      .onConflictDoUpdate({
        target: [schema.assets.spaceId, schema.assets.environmentId, schema.assets.id],
        set: {
          status: values.status,
          file: values.file,
          title: values.title,
          description: values.description,
          updatedAt: values.updatedAt,
        },
      });
  };
  return {
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.assets)
        .where(and(scopeFilter(schema.assets, scope), eq(schema.assets.id, id)));
      return row
        ? {
            id: row.id,
            status: row.status,
            file: row.file,
            title: row.title,
            description: row.description,
          }
        : null;
    },
    async list(scope, query) {
      const rows = await db
        .select()
        .from(schema.assets)
        .where(scopeFilter(schema.assets, scope))
        .orderBy(desc(schema.assets.updatedAt))
        .limit(query.limit ?? 100)
        .offset(query.skip ?? 0);
      return rows.map((r) => ({
        id: r.id,
        status: r.status,
        file: r.file,
        title: r.title,
        description: r.description,
      }));
    },
    create: upsertDraft,
    save: upsertDraft,
    async putPublished(scope, s) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        assetId: s.assetId,
        file: s.file,
        title: s.title,
        description: s.description,
        publishedAt: new Date(s.publishedAt),
      };
      await db
        .insert(schema.assetPublished)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.assetPublished.spaceId,
            schema.assetPublished.environmentId,
            schema.assetPublished.assetId,
          ],
          set: {
            file: values.file,
            title: values.title,
            description: values.description,
            publishedAt: values.publishedAt,
          },
        });
    },
    async removePublished(scope, id) {
      await db
        .delete(schema.assetPublished)
        .where(
          and(scopeFilter(schema.assetPublished, scope), eq(schema.assetPublished.assetId, id)),
        );
    },
    async getPublished(scope, id) {
      const [row] = await db
        .select()
        .from(schema.assetPublished)
        .where(
          and(scopeFilter(schema.assetPublished, scope), eq(schema.assetPublished.assetId, id)),
        );
      return row ? toPublishedAsset(row) : null;
    },
    async listPublished(scope, query) {
      const rows = await db
        .select()
        .from(schema.assetPublished)
        .where(scopeFilter(schema.assetPublished, scope))
        .orderBy(asc(schema.assetPublished.publishedAt))
        .limit(query.limit ?? 100)
        .offset(query.skip ?? 0);
      return rows.map(toPublishedAsset);
    },
  };
}

function makeReferenceRepo(db: Db): ReferenceRepo {
  return {
    async replaceForEntry(scope, fromEntryId, edges) {
      await db
        .delete(schema.references)
        .where(
          and(
            scopeFilter(schema.references, scope),
            eq(schema.references.fromEntryId, fromEntryId),
          ),
        );
      if (edges.length === 0) return;
      await db.insert(schema.references).values(
        edges.map((e) => ({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          fromEntryId: e.fromEntryId,
          fromField: e.fromField,
          toId: e.toId,
          toType: e.toType,
        })),
      );
    },
    async removeForEntry(scope, fromEntryId) {
      await db
        .delete(schema.references)
        .where(
          and(
            scopeFilter(schema.references, scope),
            eq(schema.references.fromEntryId, fromEntryId),
          ),
        );
    },
    async findForward(scope, fromEntryId) {
      const rows = await db
        .select()
        .from(schema.references)
        .where(
          and(
            scopeFilter(schema.references, scope),
            eq(schema.references.fromEntryId, fromEntryId),
          ),
        );
      return rows.map(toEdge);
    },
    async findReverse(scope, toId) {
      const rows = await db
        .select()
        .from(schema.references)
        .where(and(scopeFilter(schema.references, scope), eq(schema.references.toId, toId)));
      return rows.map(toEdge);
    },
  };
}

function makeOutboxRepo(db: Db): OutboxRepo {
  return {
    async append(event) {
      await db.insert(schema.outbox).values({
        id: event.id,
        type: event.type,
        payload: event,
        occurredAt: new Date(event.occurredAt),
      });
    },
    async readPending(limit) {
      const rows = await db
        .select()
        .from(schema.outbox)
        .where(isNull(schema.outbox.relayedAt))
        .orderBy(asc(schema.outbox.occurredAt))
        .limit(limit);
      return rows.map((r) => r.payload as DomainEvent);
    },
    async markRelayed(eventIds) {
      const now = new Date();
      for (const id of eventIds) {
        await db.update(schema.outbox).set({ relayedAt: now }).where(eq(schema.outbox.id, id));
      }
    },
  };
}

function makeWebhookRepo(db: Db): WebhookRepo {
  return {
    async create(scope, webhook) {
      await db.insert(schema.webhooks).values({
        id: webhook.id,
        spaceId: scope.spaceId,
        url: webhook.url,
        topics: [...webhook.topics],
        secret: webhook.secret,
        active: webhook.active,
        headers: webhook.headers ?? null,
      });
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.webhooks)
        .where(and(eq(schema.webhooks.spaceId, scope.spaceId), eq(schema.webhooks.id, id)));
      return row ? toWebhook(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.webhooks)
        .where(eq(schema.webhooks.spaceId, scope.spaceId));
      return rows.map(toWebhook);
    },
    async listByTopic(scope, type) {
      const rows = await db
        .select()
        .from(schema.webhooks)
        .where(eq(schema.webhooks.spaceId, scope.spaceId));
      return rows.map(toWebhook).filter((w) => matchesTopic(w, type));
    },
    async update(scope, webhook) {
      await db
        .update(schema.webhooks)
        .set({
          url: webhook.url,
          topics: [...webhook.topics],
          secret: webhook.secret,
          active: webhook.active,
          headers: webhook.headers ?? null,
        })
        .where(and(eq(schema.webhooks.spaceId, scope.spaceId), eq(schema.webhooks.id, webhook.id)));
    },
    async delete(scope, id) {
      await db
        .delete(schema.webhooks)
        .where(and(eq(schema.webhooks.spaceId, scope.spaceId), eq(schema.webhooks.id, id)));
    },
    async recordDelivery(scope, delivery) {
      await db.insert(schema.webhookDeliveries).values({
        spaceId: scope.spaceId,
        webhookId: delivery.webhookId,
        eventId: delivery.eventId,
        status: delivery.status,
        statusCode: delivery.statusCode ?? null,
        attempts: delivery.attempts,
        error: delivery.error ?? null,
      });
    },
    async listDeliveries(scope, webhookId, opts) {
      const rows = await db
        .select()
        .from(schema.webhookDeliveries)
        .where(
          and(
            eq(schema.webhookDeliveries.spaceId, scope.spaceId),
            eq(schema.webhookDeliveries.webhookId, webhookId),
          ),
        )
        .orderBy(desc(schema.webhookDeliveries.createdAt))
        .limit(opts?.limit ?? 50);
      return rows.map((r) => ({
        id: r.id,
        webhookId: r.webhookId,
        eventId: r.eventId,
        status: r.status,
        statusCode: r.statusCode ?? undefined,
        attempts: r.attempts,
        error: r.error ?? undefined,
        createdAt: r.createdAt.toISOString(),
      }));
    },
  };
}

function makeAgentRunRepo(db: Db): AgentRunRepo {
  return {
    async record(scope, run) {
      await db.insert(schema.agentRuns).values({
        id: run.id,
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        workflow: run.workflow,
        entryId: run.entryId,
        status: run.status,
        decisions: [...run.decisions],
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        createdAt: new Date(run.createdAt),
      });
    },
    async list(scope, query) {
      const conds = [eq(schema.agentRuns.spaceId, scope.spaceId)];
      if (query.workflow) conds.push(eq(schema.agentRuns.workflow, query.workflow));
      const rows = await db
        .select()
        .from(schema.agentRuns)
        .where(and(...conds))
        .orderBy(desc(schema.agentRuns.createdAt))
        .limit(query.limit ?? 100);
      return rows.map(toAgentRun);
    },
    async usage(scope, query) {
      const conds = [eq(schema.agentRuns.spaceId, scope.spaceId)];
      if (query.workflow) conds.push(eq(schema.agentRuns.workflow, query.workflow));
      if (query.since) conds.push(gte(schema.agentRuns.createdAt, new Date(query.since)));
      const [row] = await db
        .select({
          runs: count(),
          inputTokens: sum(schema.agentRuns.inputTokens),
          outputTokens: sum(schema.agentRuns.outputTokens),
        })
        .from(schema.agentRuns)
        .where(and(...conds));
      return {
        runs: Number(row?.runs ?? 0),
        inputTokens: Number(row?.inputTokens ?? 0),
        outputTokens: Number(row?.outputTokens ?? 0),
      };
    },
  };
}

function makeAuditRepo(db: Db): AuditRepo {
  return {
    async append(entry) {
      await db.insert(schema.auditLog).values({
        id: entry.id,
        spaceId: entry.spaceId,
        environmentId: entry.environmentId ?? null,
        actor: entry.actor,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        status: entry.status,
        at: new Date(entry.at),
      });
    },
    async list(spaceId, query) {
      const conds = [eq(schema.auditLog.spaceId, spaceId)];
      if (query.environmentId) conds.push(eq(schema.auditLog.environmentId, query.environmentId));
      const rows = await db
        .select()
        .from(schema.auditLog)
        .where(and(...conds))
        .orderBy(desc(schema.auditLog.at))
        .limit(query.limit ?? 100);
      return rows.map((r) => ({
        id: r.id,
        spaceId: r.spaceId,
        environmentId: r.environmentId ?? undefined,
        actor: r.actor,
        action: r.action,
        targetType: r.targetType ?? undefined,
        targetId: r.targetId ?? undefined,
        status: r.status,
        at: r.at.toISOString(),
      }));
    },
  };
}

function makeAuthRepo(db: Db): AuthRepo {
  return {
    async createApiKey(key) {
      await db.insert(schema.apiKeys).values({
        id: key.id,
        spaceId: key.spaceId,
        kind: key.kind,
        name: key.name,
        hashedToken: key.hashedToken,
        scopes: [...key.scopes],
        revoked: key.revoked,
      });
    },
    async findByHash(hashedToken) {
      const [row] = await db
        .select()
        .from(schema.apiKeys)
        .where(and(eq(schema.apiKeys.hashedToken, hashedToken), eq(schema.apiKeys.revoked, false)));
      return row ? toApiKey(row) : null;
    },
    async list(spaceId) {
      const rows = await db
        .select()
        .from(schema.apiKeys)
        .where(eq(schema.apiKeys.spaceId, spaceId));
      return rows.map(toApiKey);
    },
    async revoke(id) {
      await db.update(schema.apiKeys).set({ revoked: true }).where(eq(schema.apiKeys.id, id));
    },
  };
}

function makeSpaceRepo(db: Db): SpaceRepo {
  return {
    async getConfig(scope) {
      const [row] = await db
        .select()
        .from(schema.spaces)
        .where(eq(schema.spaces.id, scope.spaceId));
      if (!row) return null;
      return {
        spaceId: row.id,
        name: row.name,
        defaultLocale: row.defaultLocale,
        locales: row.locales,
        fallbacks: row.fallbacks ?? undefined,
      };
    },
    async list() {
      const rows = await db.select().from(schema.spaces).orderBy(asc(schema.spaces.createdAt));
      return rows.map((row) => ({
        spaceId: row.id,
        name: row.name,
        defaultLocale: row.defaultLocale,
        locales: row.locales,
        fallbacks: row.fallbacks ?? undefined,
      }));
    },
    async create(config) {
      await db
        .insert(schema.spaces)
        .values({
          id: config.spaceId,
          name: config.name,
          defaultLocale: config.defaultLocale,
          locales: [...config.locales],
          fallbacks: config.fallbacks ?? null,
        })
        .onConflictDoUpdate({
          target: schema.spaces.id,
          set: {
            name: config.name,
            defaultLocale: config.defaultLocale,
            locales: [...config.locales],
            fallbacks: config.fallbacks ?? null,
          },
        });
    },
    async createEnvironment(spaceId, environmentId, name) {
      await db
        .insert(schema.environments)
        .values({ id: environmentId, spaceId, name })
        .onConflictDoNothing();
    },
    async listEnvironments(spaceId) {
      const rows = await db
        .select()
        .from(schema.environments)
        .where(eq(schema.environments.spaceId, spaceId))
        .orderBy(asc(schema.environments.createdAt));
      return rows.map((r) => ({ id: r.id, name: r.name }));
    },
    async setAlias(spaceId, alias, targetEnvironmentId, at) {
      await db
        .insert(schema.environmentAliases)
        .values({ spaceId, alias, targetEnvironmentId, updatedAt: new Date(at) })
        .onConflictDoUpdate({
          target: [schema.environmentAliases.spaceId, schema.environmentAliases.alias],
          set: { targetEnvironmentId, updatedAt: new Date(at) },
        });
    },
    async getAlias(spaceId, alias) {
      const [row] = await db
        .select()
        .from(schema.environmentAliases)
        .where(
          and(
            eq(schema.environmentAliases.spaceId, spaceId),
            eq(schema.environmentAliases.alias, alias),
          ),
        );
      return row
        ? {
            alias: row.alias,
            targetEnvironmentId: row.targetEnvironmentId,
            updatedAt: row.updatedAt.toISOString(),
          }
        : null;
    },
    async listAliases(spaceId) {
      const rows = await db
        .select()
        .from(schema.environmentAliases)
        .where(eq(schema.environmentAliases.spaceId, spaceId))
        .orderBy(asc(schema.environmentAliases.alias));
      return rows.map((r) => ({
        alias: r.alias,
        targetEnvironmentId: r.targetEnvironmentId,
        updatedAt: r.updatedAt.toISOString(),
      }));
    },
    async deleteAlias(spaceId, alias) {
      await db
        .delete(schema.environmentAliases)
        .where(
          and(
            eq(schema.environmentAliases.spaceId, spaceId),
            eq(schema.environmentAliases.alias, alias),
          ),
        );
    },
  };
}

/** Creates a Postgres-backed ContentStore. Owns the connection pool. */
type ReleaseRow = typeof schema.releases.$inferSelect;
const toRelease = (r: ReleaseRow): Release => ({
  id: r.id,
  title: r.title,
  description: r.description ?? undefined,
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  publishedAt: r.publishedAt?.toISOString(),
});

function makeReleaseRepo(db: Db): ReleaseRepo {
  return {
    async create(scope, release) {
      await db.insert(schema.releases).values({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: release.id,
        title: release.title,
        description: release.description ?? null,
        status: release.status,
        createdAt: new Date(release.createdAt),
        publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
      });
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.releases)
        .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, id)));
      return row ? toRelease(row) : null;
    },
    async list(scope) {
      const rows = await db
        .select()
        .from(schema.releases)
        .where(scopeFilter(schema.releases, scope))
        .orderBy(desc(schema.releases.createdAt));
      return rows.map(toRelease);
    },
    async save(scope, release) {
      await db
        .update(schema.releases)
        .set({
          title: release.title,
          description: release.description ?? null,
          status: release.status,
          publishedAt: release.publishedAt ? new Date(release.publishedAt) : null,
        })
        .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, release.id)));
    },
    async delete(scope, id) {
      await db
        .delete(schema.releaseItems)
        .where(and(scopeFilter(schema.releaseItems, scope), eq(schema.releaseItems.releaseId, id)));
      await db
        .delete(schema.releases)
        .where(and(scopeFilter(schema.releases, scope), eq(schema.releases.id, id)));
    },
    async addItem(scope, releaseId, item) {
      await db
        .insert(schema.releaseItems)
        .values({
          spaceId: scope.spaceId,
          environmentId: scope.environmentId,
          releaseId,
          entityType: item.entityType,
          entityId: item.entityId,
          action: item.action,
        })
        .onConflictDoUpdate({
          target: [
            schema.releaseItems.spaceId,
            schema.releaseItems.environmentId,
            schema.releaseItems.releaseId,
            schema.releaseItems.entityId,
          ],
          set: { action: item.action, entityType: item.entityType },
        });
    },
    async removeItem(scope, releaseId, entityId) {
      await db
        .delete(schema.releaseItems)
        .where(
          and(
            scopeFilter(schema.releaseItems, scope),
            eq(schema.releaseItems.releaseId, releaseId),
            eq(schema.releaseItems.entityId, entityId),
          ),
        );
    },
    async listItems(scope, releaseId) {
      const rows = await db
        .select()
        .from(schema.releaseItems)
        .where(
          and(
            scopeFilter(schema.releaseItems, scope),
            eq(schema.releaseItems.releaseId, releaseId),
          ),
        );
      return rows.map((r) => ({
        entityType: r.entityType,
        entityId: r.entityId,
        action: r.action,
      }));
    },
  };
}

type ScheduledRow = typeof schema.scheduledActions.$inferSelect;
const toScheduled = (r: ScheduledRow): ScheduledAction => ({
  id: r.id,
  action: r.action,
  entityType: r.entityType,
  entityId: r.entityId,
  scheduledFor: r.scheduledFor.toISOString(),
  status: r.status,
  createdAt: r.createdAt.toISOString(),
  executedAt: r.executedAt?.toISOString(),
  error: r.error ?? undefined,
});

function makeScheduledActionRepo(db: Db): ScheduledActionRepo {
  const rowValues = (scope: Scope, a: ScheduledAction) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: a.id,
    action: a.action,
    entityType: a.entityType,
    entityId: a.entityId,
    scheduledFor: new Date(a.scheduledFor),
    status: a.status,
    createdAt: new Date(a.createdAt),
    executedAt: a.executedAt ? new Date(a.executedAt) : null,
    error: a.error ?? null,
  });
  return {
    async create(scope, action) {
      await db.insert(schema.scheduledActions).values(rowValues(scope, action));
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.scheduledActions)
        .where(
          and(scopeFilter(schema.scheduledActions, scope), eq(schema.scheduledActions.id, id)),
        );
      return row ? toScheduled(row) : null;
    },
    async list(scope, query) {
      const conditions = [scopeFilter(schema.scheduledActions, scope)];
      if (query?.status)
        conditions.push(eq(schema.scheduledActions.status, query.status as ScheduledRow['status']));
      const rows = await db
        .select()
        .from(schema.scheduledActions)
        .where(and(...conditions))
        .orderBy(asc(schema.scheduledActions.scheduledFor));
      return rows.map(toScheduled);
    },
    async save(scope, action) {
      await db
        .update(schema.scheduledActions)
        .set({
          status: action.status,
          executedAt: action.executedAt ? new Date(action.executedAt) : null,
          error: action.error ?? null,
        })
        .where(
          and(
            scopeFilter(schema.scheduledActions, scope),
            eq(schema.scheduledActions.id, action.id),
          ),
        );
    },
    async findDue(now, limit = 100): Promise<ScopedScheduledAction[]> {
      const rows = await db
        .select()
        .from(schema.scheduledActions)
        .where(
          and(
            eq(schema.scheduledActions.status, 'pending'),
            lte(schema.scheduledActions.scheduledFor, new Date(now)),
          ),
        )
        .orderBy(asc(schema.scheduledActions.scheduledFor))
        .limit(limit);
      return rows.map((r) => ({
        scope: { spaceId: r.spaceId, environmentId: r.environmentId },
        action: toScheduled(r),
      }));
    },
  };
}

function makeCommentRepo(db: Db): CommentRepo {
  const toComment = (r: typeof schema.comments.$inferSelect): Comment => ({
    id: r.id,
    entryId: r.entryId,
    parentId: r.parentId,
    author: r.author,
    body: r.body,
    createdAt: r.createdAt.toISOString(),
  });
  return {
    async create(scope, comment) {
      await db.insert(schema.comments).values({
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: comment.id,
        entryId: comment.entryId,
        parentId: comment.parentId,
        author: comment.author,
        body: comment.body,
        createdAt: new Date(comment.createdAt),
      });
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.id, id)));
      return row ? toComment(row) : null;
    },
    async listForEntry(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.entryId, entryId)))
        .orderBy(asc(schema.comments.createdAt));
      return rows.map(toComment);
    },
    async delete(scope, id) {
      await db
        .delete(schema.comments)
        .where(and(scopeFilter(schema.comments, scope), eq(schema.comments.id, id)));
    },
  };
}

function makeTaskRepo(db: Db): TaskRepo {
  const toTask = (r: typeof schema.tasks.$inferSelect): Task => ({
    id: r.id,
    entryId: r.entryId,
    assignee: r.assignee,
    body: r.body,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString(),
  });
  const values = (scope: Scope, t: Task) => ({
    spaceId: scope.spaceId,
    environmentId: scope.environmentId,
    id: t.id,
    entryId: t.entryId,
    assignee: t.assignee,
    body: t.body,
    status: t.status,
    createdAt: new Date(t.createdAt),
    resolvedAt: t.resolvedAt ? new Date(t.resolvedAt) : null,
  });
  return {
    async create(scope, task) {
      await db.insert(schema.tasks).values(values(scope, task));
    },
    async get(scope, id) {
      const [row] = await db
        .select()
        .from(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, id)));
      return row ? toTask(row) : null;
    },
    async listForEntry(scope, entryId) {
      const rows = await db
        .select()
        .from(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.entryId, entryId)))
        .orderBy(asc(schema.tasks.createdAt));
      return rows.map(toTask);
    },
    async save(scope, task) {
      await db
        .update(schema.tasks)
        .set({
          assignee: task.assignee,
          body: task.body,
          status: task.status,
          resolvedAt: task.resolvedAt ? new Date(task.resolvedAt) : null,
        })
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, task.id)));
    },
    async delete(scope, id) {
      await db
        .delete(schema.tasks)
        .where(and(scopeFilter(schema.tasks, scope), eq(schema.tasks.id, id)));
    },
  };
}

function makeWorkflowRepo(db: Db): WorkflowRepo {
  const toDef = (r: typeof schema.workflowDefinitions.$inferSelect): WorkflowDefinition => ({
    id: r.id,
    name: r.name,
    steps: r.steps as WorkflowStep[],
  });
  return {
    async saveDefinition(scope, def) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        id: def.id,
        name: def.name,
        steps: [...def.steps],
      };
      await db
        .insert(schema.workflowDefinitions)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.workflowDefinitions.spaceId,
            schema.workflowDefinitions.environmentId,
            schema.workflowDefinitions.id,
          ],
          set: { name: values.name, steps: values.steps },
        });
    },
    async getDefinition(scope, id) {
      const [row] = await db
        .select()
        .from(schema.workflowDefinitions)
        .where(
          and(
            scopeFilter(schema.workflowDefinitions, scope),
            eq(schema.workflowDefinitions.id, id),
          ),
        );
      return row ? toDef(row) : null;
    },
    async listDefinitions(scope) {
      const rows = await db
        .select()
        .from(schema.workflowDefinitions)
        .where(scopeFilter(schema.workflowDefinitions, scope));
      return rows.map(toDef);
    },
    async deleteDefinition(scope, id) {
      await db
        .delete(schema.workflowDefinitions)
        .where(
          and(
            scopeFilter(schema.workflowDefinitions, scope),
            eq(schema.workflowDefinitions.id, id),
          ),
        );
    },
    async getState(scope, entryId) {
      const [row] = await db
        .select()
        .from(schema.entryWorkflowState)
        .where(
          and(
            scopeFilter(schema.entryWorkflowState, scope),
            eq(schema.entryWorkflowState.entryId, entryId),
          ),
        );
      return row
        ? { entryId: row.entryId, workflowId: row.workflowId, currentStepId: row.currentStepId }
        : null;
    },
    async saveState(scope, state) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId: state.entryId,
        workflowId: state.workflowId,
        currentStepId: state.currentStepId,
      };
      await db
        .insert(schema.entryWorkflowState)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.entryWorkflowState.spaceId,
            schema.entryWorkflowState.environmentId,
            schema.entryWorkflowState.entryId,
          ],
          set: { workflowId: values.workflowId, currentStepId: values.currentStepId },
        });
    },
  };
}

function makeTaxonomyRepo(db: Db): TaxonomyRepo {
  const toConcept = (r: typeof schema.concepts.$inferSelect): Concept => ({
    id: r.id,
    schemeId: r.schemeId,
    prefLabel: r.prefLabel,
    broaderId: r.broaderId,
  });
  return {
    async createScheme(scope, scheme) {
      await db
        .insert(schema.conceptSchemes)
        .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...scheme })
        .onConflictDoUpdate({
          target: [
            schema.conceptSchemes.spaceId,
            schema.conceptSchemes.environmentId,
            schema.conceptSchemes.id,
          ],
          set: { name: scheme.name },
        });
    },
    async listSchemes(scope) {
      return db
        .select()
        .from(schema.conceptSchemes)
        .where(scopeFilter(schema.conceptSchemes, scope));
    },
    async getScheme(scope, id) {
      const [row] = await db
        .select()
        .from(schema.conceptSchemes)
        .where(and(scopeFilter(schema.conceptSchemes, scope), eq(schema.conceptSchemes.id, id)));
      return row ?? null;
    },
    async deleteScheme(scope, id) {
      await db
        .delete(schema.conceptSchemes)
        .where(and(scopeFilter(schema.conceptSchemes, scope), eq(schema.conceptSchemes.id, id)));
    },
    async createConcept(scope, concept) {
      await db
        .insert(schema.concepts)
        .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...concept })
        .onConflictDoUpdate({
          target: [schema.concepts.spaceId, schema.concepts.environmentId, schema.concepts.id],
          set: {
            schemeId: concept.schemeId,
            prefLabel: concept.prefLabel,
            broaderId: concept.broaderId,
          },
        });
    },
    async getConcept(scope, id) {
      const [row] = await db
        .select()
        .from(schema.concepts)
        .where(and(scopeFilter(schema.concepts, scope), eq(schema.concepts.id, id)));
      return row ? toConcept(row) : null;
    },
    async listConcepts(scope, schemeId) {
      const conds = [scopeFilter(schema.concepts, scope)];
      if (schemeId) conds.push(eq(schema.concepts.schemeId, schemeId));
      const rows = await db
        .select()
        .from(schema.concepts)
        .where(and(...conds));
      return rows.map(toConcept);
    },
    async deleteConcept(scope, id) {
      await db
        .delete(schema.concepts)
        .where(and(scopeFilter(schema.concepts, scope), eq(schema.concepts.id, id)));
    },
    async createTag(scope, tag) {
      await db
        .insert(schema.tags)
        .values({ spaceId: scope.spaceId, environmentId: scope.environmentId, ...tag })
        .onConflictDoUpdate({
          target: [schema.tags.spaceId, schema.tags.environmentId, schema.tags.id],
          set: { name: tag.name },
        });
    },
    async getTag(scope, id) {
      const [row] = await db
        .select()
        .from(schema.tags)
        .where(and(scopeFilter(schema.tags, scope), eq(schema.tags.id, id)));
      return row ?? null;
    },
    async listTags(scope) {
      return db.select().from(schema.tags).where(scopeFilter(schema.tags, scope));
    },
    async deleteTag(scope, id) {
      await db
        .delete(schema.tags)
        .where(and(scopeFilter(schema.tags, scope), eq(schema.tags.id, id)));
    },
    async getEntryMetadata(scope, entryId) {
      const [row] = await db
        .select()
        .from(schema.entryMetadata)
        .where(
          and(scopeFilter(schema.entryMetadata, scope), eq(schema.entryMetadata.entryId, entryId)),
        );
      return row ? { tags: row.tags, concepts: row.concepts } : null;
    },
    async setEntryMetadata(scope, entryId, metadata: EntryMetadata) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId,
        tags: [...metadata.tags],
        concepts: [...metadata.concepts],
      };
      await db
        .insert(schema.entryMetadata)
        .values(values)
        .onConflictDoUpdate({
          target: [
            schema.entryMetadata.spaceId,
            schema.entryMetadata.environmentId,
            schema.entryMetadata.entryId,
          ],
          set: { tags: values.tags, concepts: values.concepts },
        });
    },
  };
}

export function createPostgresStore(
  connectionString: string,
): ContentStore & { close(): Promise<void> } {
  const sql = postgres(connectionString);
  const db = drizzle(sql, { schema });
  return {
    spaces: makeSpaceRepo(db),
    contentTypes: makeContentTypeRepo(db),
    entries: makeEntryRepo(db),
    assets: makeAssetRepo(db),
    references: makeReferenceRepo(db),
    webhooks: makeWebhookRepo(db),
    auth: makeAuthRepo(db),
    agentRuns: makeAgentRunRepo(db),
    audit: makeAuditRepo(db),
    releases: makeReleaseRepo(db),
    scheduledActions: makeScheduledActionRepo(db),
    comments: makeCommentRepo(db),
    tasks: makeTaskRepo(db),
    workflows: makeWorkflowRepo(db),
    taxonomy: makeTaxonomyRepo(db),
    outbox: makeOutboxRepo(db),
    async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
      return db.transaction(async (txdb) => {
        const tx: ContentStoreTx = {
          contentTypes: makeContentTypeRepo(txdb as unknown as Db),
          entries: makeEntryRepo(txdb as unknown as Db),
          assets: makeAssetRepo(txdb as unknown as Db),
          references: makeReferenceRepo(txdb as unknown as Db),
          releases: makeReleaseRepo(txdb as unknown as Db),
          outbox: makeOutboxRepo(txdb as unknown as Db),
        };
        return fn(tx);
      });
    },
    async close() {
      await sql.end();
    },
  };
}

// ---- row mappers ----------------------------------------------------------

type CtRow = typeof schema.contentTypes.$inferSelect;
type EntryRow = typeof schema.entries.$inferSelect;
type PubRow = typeof schema.entryPublished.$inferSelect;

const toContentType = (r: CtRow): ContentType => ({
  apiId: r.apiId,
  name: r.name,
  displayField: r.displayField,
  fields: r.fields,
  version: r.version,
  status: r.status,
});

const toEntry = (r: EntryRow): Entry => ({
  id: r.id,
  contentTypeApiId: r.contentTypeApiId,
  status: r.status,
  currentVersion: r.currentVersion,
  publishedVersion: r.publishedVersion,
});

type AgentRunRow = typeof schema.agentRuns.$inferSelect;
const toAgentRun = (r: AgentRunRow): AgentRunRecord => ({
  id: r.id,
  workflow: r.workflow,
  entryId: r.entryId,
  status: r.status,
  decisions: r.decisions,
  inputTokens: r.inputTokens,
  outputTokens: r.outputTokens,
  createdAt: r.createdAt.toISOString(),
});

type ApiKeyRow = typeof schema.apiKeys.$inferSelect;
const toApiKey = (r: ApiKeyRow): ApiKey => ({
  id: r.id,
  spaceId: r.spaceId,
  kind: r.kind,
  name: r.name ?? undefined,
  hashedToken: r.hashedToken,
  scopes: r.scopes,
  revoked: r.revoked,
});

type WebhookRow = typeof schema.webhooks.$inferSelect;
const toWebhook = (r: WebhookRow): Webhook => ({
  id: r.id,
  url: r.url,
  topics: r.topics as Webhook['topics'],
  secret: r.secret,
  active: r.active,
  headers: r.headers ?? undefined,
});

type PubAssetRow = typeof schema.assetPublished.$inferSelect;
const toPublishedAsset = (r: PubAssetRow): PublishedAsset => ({
  assetId: r.assetId,
  file: r.file,
  title: r.title,
  description: r.description,
  publishedAt: r.publishedAt.toISOString(),
});

type RefRow = typeof schema.references.$inferSelect;
const toEdge = (r: RefRow): ReferenceEdge => ({
  fromEntryId: r.fromEntryId,
  fromField: r.fromField,
  toId: r.toId,
  toType: r.toType,
});

const toPublished = (r: PubRow): PublishedEntry => ({
  entryId: r.entryId,
  contentTypeApiId: r.contentTypeApiId,
  version: r.version,
  fields: r.fields,
  publishedAt: r.publishedAt.toISOString(),
  ...(r.metadata ? { metadata: r.metadata } : {}),
});

const entryRow = (scope: Scope, entry: Entry) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  id: entry.id,
  contentTypeApiId: entry.contentTypeApiId,
  status: entry.status,
  currentVersion: entry.currentVersion,
  publishedVersion: entry.publishedVersion,
  updatedAt: new Date(),
});

const versionRow = (scope: Scope, version: EntryVersion) => ({
  spaceId: scope.spaceId,
  environmentId: scope.environmentId,
  entryId: version.entryId,
  version: version.version,
  fields: version.fields,
  // Honor a use-case-supplied timestamp (deterministic via the clock); else the
  // column defaults to now().
  ...(version.createdAt ? { createdAt: new Date(version.createdAt) } : {}),
});

type EntryVersionRow = typeof schema.entryVersions.$inferSelect;
const toVersion = (r: EntryVersionRow): EntryVersion => ({
  entryId: r.entryId,
  version: r.version,
  fields: r.fields,
  createdAt: r.createdAt.toISOString(),
});

async function saveEntryAggregate(db: Db, scope: Scope, entry: Entry): Promise<void> {
  await db
    .update(schema.entries)
    .set({
      status: entry.status,
      currentVersion: entry.currentVersion,
      publishedVersion: entry.publishedVersion,
      updatedAt: new Date(),
    })
    .where(and(scopeFilter(schema.entries, scope), eq(schema.entries.id, entry.id)));
}

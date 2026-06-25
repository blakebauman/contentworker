import {
  type ApiKey,
  type Asset,
  type ContentType,
  type DomainEvent,
  type Entry,
  type EntryVersion,
  type ReferenceEdge,
  type Scope,
  type Webhook,
  matchesTopic,
} from '@cw/domain';
import type {
  AgentRunRecord,
  AgentRunRepo,
  AssetRepo,
  AuthRepo,
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
  SpaceRepo,
  WebhookRepo,
} from '@cw/ports';
import { and, asc, count, desc, eq, gt, gte, isNull, sum } from 'drizzle-orm';
import { type PostgresJsDatabase, drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema.js';

type Db = PostgresJsDatabase<typeof schema>;

const scopeFilter = (t: { spaceId: unknown; environmentId: unknown }, scope: Scope) =>
  and(eq(t.spaceId as never, scope.spaceId), eq(t.environmentId as never, scope.environmentId));

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
      const conditions = [scopeFilter(schema.entries, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entries.contentTypeApiId, query.contentTypeApiId));
      }
      const rows = await db
        .select()
        .from(schema.entries)
        .where(and(...conditions))
        .orderBy(asc(schema.entries.updatedAt))
        .limit(query.limit ?? 100)
        .offset(query.skip ?? 0);
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
      return results;
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
    async putPublished(scope, snapshot) {
      const values = {
        spaceId: scope.spaceId,
        environmentId: scope.environmentId,
        entryId: snapshot.entryId,
        contentTypeApiId: snapshot.contentTypeApiId,
        version: snapshot.version,
        fields: snapshot.fields,
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
      const conditions = [scopeFilter(schema.entryPublished, scope)];
      if (query.contentTypeApiId) {
        conditions.push(eq(schema.entryPublished.contentTypeApiId, query.contentTypeApiId));
      }
      if (query.since) conditions.push(gt(schema.entryPublished.publishedAt, new Date(query.since)));
      const rows = await db
        .select()
        .from(schema.entryPublished)
        .where(and(...conditions))
        .orderBy(asc(schema.entryPublished.publishedAt))
        .limit(query.limit ?? 100)
        .offset(query.skip ?? 0);
      return rows.map(toPublished);
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
      return rows.map((r) => ({ id: r.id, status: r.status, file: r.file, title: r.title, description: r.description }));
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
  };
}

/** Creates a Postgres-backed ContentStore. Owns the connection pool. */
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
    outbox: makeOutboxRepo(db),
    async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
      return db.transaction(async (txdb) => {
        const tx: ContentStoreTx = {
          contentTypes: makeContentTypeRepo(txdb as unknown as Db),
          entries: makeEntryRepo(txdb as unknown as Db),
          assets: makeAssetRepo(txdb as unknown as Db),
          references: makeReferenceRepo(txdb as unknown as Db),
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

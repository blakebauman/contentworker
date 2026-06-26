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
  SpaceConfig,
  SpaceRepo,
  WebhookDeliveryRecord,
  WebhookRepo,
} from '@cw/ports';

const scopeKey = (s: Scope) => `${s.spaceId}::${s.environmentId}`;

/**
 * An in-memory ContentStore for fast, infra-free tests. It mirrors the Postgres
 * adapter's observable behavior (scoping, versioning, published read model,
 * outbox) without isolation guarantees — transactions simply run the callback.
 */
export class InMemoryContentStore implements ContentStore {
  private readonly spaceConfigs = new Map<string, SpaceConfig>();
  private readonly contentTypeData = new Map<string, ContentType>();
  private readonly entryData = new Map<string, Entry>();
  private readonly versionData = new Map<string, EntryVersion[]>();
  private readonly publishedData = new Map<string, PublishedEntry>();
  private readonly outboxData: { event: DomainEvent; relayed: boolean }[] = [];

  private readonly environmentData = new Map<string, { id: string; name: string }[]>();

  readonly spaces: SpaceRepo = {
    getConfig: async (scope) => this.spaceConfigs.get(scope.spaceId) ?? null,
    list: async () => [...this.spaceConfigs.values()],
    create: async (config) => {
      this.spaceConfigs.set(config.spaceId, config);
    },
    createEnvironment: async (spaceId, environmentId, name) => {
      const list = this.environmentData.get(spaceId) ?? [];
      if (!list.some((e) => e.id === environmentId)) list.push({ id: environmentId, name });
      this.environmentData.set(spaceId, list);
    },
    listEnvironments: async (spaceId) => this.environmentData.get(spaceId) ?? [],
  };

  readonly contentTypes: ContentTypeRepo = {
    get: async (scope, apiId) => this.contentTypeData.get(`${scopeKey(scope)}::${apiId}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.contentTypeData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    save: async (scope, ct) => {
      this.contentTypeData.set(`${scopeKey(scope)}::${ct.apiId}`, ct);
    },
  };

  readonly entries: EntryRepo = {
    get: async (scope, id) => {
      const entry = this.entryData.get(`${scopeKey(scope)}::${id}`);
      if (!entry) return null;
      const versions = this.versionData.get(`${scopeKey(scope)}::${id}`) ?? [];
      const current = versions.find((v) => v.version === entry.currentVersion);
      const result: EntryWithFields = { entry, fields: current?.fields ?? {} };
      return result;
    },
    list: async (scope, query: EntryQuery) => {
      const prefix = `${scopeKey(scope)}::`;
      let entries = [...this.entryData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      if (query.contentTypeApiId) {
        entries = entries.filter((e) => e.contentTypeApiId === query.contentTypeApiId);
      }
      const skip = query.skip ?? 0;
      const limit = query.limit ?? 100;
      return entries.slice(skip, skip + limit).map((entry) => {
        const versions = this.versionData.get(`${scopeKey(scope)}::${entry.id}`) ?? [];
        const current = versions.find((v) => v.version === entry.currentVersion);
        return { entry, fields: current?.fields ?? {} };
      });
    },
    create: async (scope, entry, version) => {
      this.entryData.set(`${scopeKey(scope)}::${entry.id}`, entry);
      this.versionData.set(`${scopeKey(scope)}::${entry.id}`, [version]);
    },
    saveVersion: async (scope, entry, version) => {
      this.entryData.set(`${scopeKey(scope)}::${entry.id}`, entry);
      const key = `${scopeKey(scope)}::${entry.id}`;
      const versions = this.versionData.get(key) ?? [];
      versions.push(version);
      this.versionData.set(key, versions);
    },
    saveAggregate: async (scope, entry) => {
      this.entryData.set(`${scopeKey(scope)}::${entry.id}`, entry);
    },
    putPublished: async (scope, snapshot) => {
      this.publishedData.set(`${scopeKey(scope)}::${snapshot.entryId}`, snapshot);
    },
    removePublished: async (scope, entryId) => {
      this.publishedData.delete(`${scopeKey(scope)}::${entryId}`);
    },
    getPublished: async (scope, id) => this.publishedData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listPublished: async (scope, query: EntryQuery) => {
      const prefix = `${scopeKey(scope)}::`;
      let rows = [...this.publishedData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      if (query.contentTypeApiId) {
        rows = rows.filter((r) => r.contentTypeApiId === query.contentTypeApiId);
      }
      if (query.since) rows = rows.filter((r) => r.publishedAt > (query.since as string));
      // Order by publishedAt so a `since` cursor advances deterministically.
      rows.sort((a, b) =>
        a.publishedAt < b.publishedAt ? -1 : a.publishedAt > b.publishedAt ? 1 : 0,
      );
      const skip = query.skip ?? 0;
      const limit = query.limit ?? 100;
      return rows.slice(skip, skip + limit);
    },
  };

  private readonly assetData = new Map<string, Asset>();
  private readonly publishedAssetData = new Map<string, PublishedAsset>();

  readonly assets: AssetRepo = {
    get: async (scope, id) => this.assetData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      const rows = [...this.assetData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      const skip = query.skip ?? 0;
      return rows.slice(skip, skip + (query.limit ?? 100));
    },
    create: async (scope, asset) => {
      this.assetData.set(`${scopeKey(scope)}::${asset.id}`, asset);
    },
    save: async (scope, asset) => {
      this.assetData.set(`${scopeKey(scope)}::${asset.id}`, asset);
    },
    putPublished: async (scope, snapshot) => {
      this.publishedAssetData.set(`${scopeKey(scope)}::${snapshot.assetId}`, snapshot);
    },
    removePublished: async (scope, id) => {
      this.publishedAssetData.delete(`${scopeKey(scope)}::${id}`);
    },
    getPublished: async (scope, id) =>
      this.publishedAssetData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listPublished: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      const rows = [...this.publishedAssetData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      const skip = query.skip ?? 0;
      return rows.slice(skip, skip + (query.limit ?? 100));
    },
  };

  private referenceData = new Map<string, ReferenceEdge[]>();

  readonly references: ReferenceRepo = {
    replaceForEntry: async (scope, fromEntryId, edges) => {
      this.referenceData.set(`${scopeKey(scope)}::${fromEntryId}`, [...edges]);
    },
    removeForEntry: async (scope, fromEntryId) => {
      this.referenceData.delete(`${scopeKey(scope)}::${fromEntryId}`);
    },
    findForward: async (scope, fromEntryId) =>
      this.referenceData.get(`${scopeKey(scope)}::${fromEntryId}`) ?? [],
    findReverse: async (scope, toId) => {
      const prefix = `${scopeKey(scope)}::`;
      const out: ReferenceEdge[] = [];
      for (const [k, edges] of this.referenceData.entries()) {
        if (!k.startsWith(prefix)) continue;
        out.push(...edges.filter((e) => e.toId === toId));
      }
      return out;
    },
  };

  private readonly webhookData = new Map<string, Webhook[]>();
  readonly webhookDeliveries: WebhookDeliveryRecord[] = [];
  private deliverySeq = 0;

  readonly webhooks: WebhookRepo = {
    create: async (scope, webhook) => {
      const key = scope.spaceId;
      const list = this.webhookData.get(key) ?? [];
      list.push(webhook);
      this.webhookData.set(key, list);
    },
    get: async (scope, id) =>
      (this.webhookData.get(scope.spaceId) ?? []).find((w) => w.id === id) ?? null,
    list: async (scope) => this.webhookData.get(scope.spaceId) ?? [],
    listByTopic: async (scope, type) =>
      (this.webhookData.get(scope.spaceId) ?? []).filter((w) => matchesTopic(w, type)),
    update: async (scope, webhook) => {
      const list = this.webhookData.get(scope.spaceId) ?? [];
      this.webhookData.set(
        scope.spaceId,
        list.map((w) => (w.id === webhook.id ? webhook : w)),
      );
    },
    delete: async (scope, id) => {
      const list = this.webhookData.get(scope.spaceId) ?? [];
      this.webhookData.set(
        scope.spaceId,
        list.filter((w) => w.id !== id),
      );
    },
    recordDelivery: async (_scope, delivery) => {
      this.deliverySeq += 1;
      this.webhookDeliveries.push({
        ...delivery,
        id: this.deliverySeq,
        createdAt: new Date(this.deliverySeq).toISOString(),
      });
    },
    listDeliveries: async (_scope, webhookId, opts) =>
      this.webhookDeliveries
        .filter((d) => d.webhookId === webhookId)
        .sort((a, b) => b.id - a.id)
        .slice(0, opts?.limit ?? 50),
  };

  private readonly apiKeyData = new Map<string, ApiKey>();

  readonly auth: AuthRepo = {
    createApiKey: async (key) => {
      this.apiKeyData.set(key.id, key);
    },
    findByHash: async (hashedToken) =>
      [...this.apiKeyData.values()].find((k) => k.hashedToken === hashedToken && !k.revoked) ??
      null,
    list: async (spaceId) => [...this.apiKeyData.values()].filter((k) => k.spaceId === spaceId),
    revoke: async (id) => {
      const existing = this.apiKeyData.get(id);
      if (existing) this.apiKeyData.set(id, { ...existing, revoked: true });
    },
  };

  private readonly agentRunData = new Map<string, AgentRunRecord[]>();

  readonly agentRuns: AgentRunRepo = {
    record: async (scope, run) => {
      const list = this.agentRunData.get(scope.spaceId) ?? [];
      list.push(run);
      this.agentRunData.set(scope.spaceId, list);
    },
    list: async (scope, query) => {
      let rows = [...(this.agentRunData.get(scope.spaceId) ?? [])];
      if (query.workflow) rows = rows.filter((r) => r.workflow === query.workflow);
      rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)); // newest first
      return rows.slice(0, query.limit ?? 100);
    },
    usage: async (scope, query) => {
      let rows = this.agentRunData.get(scope.spaceId) ?? [];
      if (query.workflow) rows = rows.filter((r) => r.workflow === query.workflow);
      if (query.since) rows = rows.filter((r) => r.createdAt >= (query.since as string));
      return rows.reduce(
        (acc, r) => ({
          runs: acc.runs + 1,
          inputTokens: acc.inputTokens + r.inputTokens,
          outputTokens: acc.outputTokens + r.outputTokens,
        }),
        { runs: 0, inputTokens: 0, outputTokens: 0 },
      );
    },
  };

  readonly outbox: OutboxRepo = {
    append: async (event) => {
      this.outboxData.push({ event, relayed: false });
    },
    readPending: async (limit) =>
      this.outboxData
        .filter((r) => !r.relayed)
        .slice(0, limit)
        .map((r) => r.event),
    markRelayed: async (eventIds) => {
      const ids = new Set(eventIds);
      for (const row of this.outboxData) {
        if (ids.has(row.event.id)) row.relayed = true;
      }
    },
  };

  async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
    return fn({
      contentTypes: this.contentTypes,
      entries: this.entries,
      assets: this.assets,
      references: this.references,
      outbox: this.outbox,
    });
  }

  // ---- test helpers -------------------------------------------------------

  /** Seeds a space's locale configuration (name defaults to the space id). */
  seedSpace(config: Omit<SpaceConfig, 'name'> & { name?: string }): void {
    this.spaceConfigs.set(config.spaceId, { name: config.spaceId, ...config });
  }

  /** Synchronously seeds an API key (avoids startup races in dev/tests). */
  seedApiKey(key: ApiKey): void {
    this.apiKeyData.set(key.id, key);
  }

  /** Returns all outbox events appended so far (relayed or not). */
  allEvents(): DomainEvent[] {
    return this.outboxData.map((r) => r.event);
  }
}

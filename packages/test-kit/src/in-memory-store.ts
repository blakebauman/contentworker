import {
  type AgentReview,
  type AgentSchedule,
  type ApiKey,
  type Asset,
  type Comment,
  type Concept,
  type ConceptScheme,
  type ContentType,
  type DomainEvent,
  type Entry,
  type EntryMetadata,
  type EntryVersion,
  type EntryWorkflowState,
  type ReferenceEdge,
  type Release,
  type ReleaseItem,
  type Role,
  type Scope,
  type Tag,
  type Task,
  type Webhook,
  type WorkflowDefinition,
  matchesTopic,
  projectFields,
  runEntryQuery,
} from '@cw/domain';
import type {
  AIActionDefinition,
  AIActionRepo,
  AgentReviewRepo,
  AgentRunRecord,
  AgentRunRepo,
  AgentScheduleRepo,
  AppExtension,
  AppExtensionRepo,
  AssetRepo,
  AuditEntry,
  AuditRepo,
  AuthRepo,
  CommentRepo,
  ContentStore,
  ContentStoreTx,
  ContentTypeRepo,
  EntryQuery,
  EntryRepo,
  EntryWithFields,
  EnvironmentAlias,
  FunctionDefinition,
  FunctionRepo,
  OutboxRepo,
  PreviewTokenRecord,
  PreviewTokenRepo,
  PublishedAsset,
  PublishedEntry,
  ReferenceRepo,
  ReleaseRepo,
  RoleRepo,
  ScheduledActionRepo,
  ScopedScheduledAction,
  SpaceConfig,
  SpaceRepo,
  TaskRepo,
  TaxonomyRepo,
  WebhookDeliveryRecord,
  WebhookRepo,
  WorkflowRepo,
} from '@cw/ports';

const scopeKey = (s: Scope) => `${s.spaceId}::${s.environmentId}`;

/**
 * An in-memory ContentStore for fast, infra-free tests. It mirrors the Postgres
 * adapter's observable behavior (scoping, versioning, published read model,
 * outbox) without isolation guarantees — transactions simply run the callback.
 */
export class InMemoryContentStore implements ContentStore {
  /**
   * Time source for adapter-stamped instants (outbox `relayedAt`) — the fields
   * the REAL adapter stamps with database time, not the use-case clock. Tests
   * exercising retention point this at their FixedClock for determinism.
   */
  nowMs: () => number = () => Date.now();

  private readonly spaceConfigs = new Map<string, SpaceConfig>();
  private readonly contentTypeData = new Map<string, ContentType>();
  private readonly entryData = new Map<string, Entry>();
  private readonly versionData = new Map<string, EntryVersion[]>();
  private readonly publishedData = new Map<string, PublishedEntry>();
  private readonly outboxData: { event: DomainEvent; relayed: boolean; relayedAt?: number }[] = [];

  private readonly environmentData = new Map<string, { id: string; name: string }[]>();
  private readonly aliasData = new Map<string, EnvironmentAlias>();

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
    setAlias: async (spaceId, alias, targetEnvironmentId, at) => {
      this.aliasData.set(`${spaceId}::${alias}`, { alias, targetEnvironmentId, updatedAt: at });
    },
    getAlias: async (spaceId, alias) => this.aliasData.get(`${spaceId}::${alias}`) ?? null,
    listAliases: async (spaceId) => {
      const prefix = `${spaceId}::`;
      return [...this.aliasData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    deleteAlias: async (spaceId, alias) => {
      this.aliasData.delete(`${spaceId}::${alias}`);
    },
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
      const withFields: EntryWithFields[] = entries.map((entry) => {
        const versions = this.versionData.get(`${scopeKey(scope)}::${entry.id}`) ?? [];
        const current = versions.find((v) => v.version === entry.currentVersion);
        return { entry, fields: current?.fields ?? {} };
      });
      const filtered = runEntryQuery(
        withFields,
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
    listVersions: async (scope, entryId) =>
      [...(this.versionData.get(`${scopeKey(scope)}::${entryId}`) ?? [])].sort(
        (a, b) => b.version - a.version,
      ),
    getVersion: async (scope, entryId, version) =>
      this.versionData.get(`${scopeKey(scope)}::${entryId}`)?.find((v) => v.version === version) ??
      null,
    putPublished: async (scope, snapshot) => {
      this.publishedData.set(`${scopeKey(scope)}::${snapshot.entryId}`, snapshot);
    },
    removePublished: async (scope, entryId) => {
      this.publishedData.delete(`${scopeKey(scope)}::${entryId}`);
    },
    getPublished: async (scope, id) => this.publishedData.get(`${scopeKey(scope)}::${id}`) ?? null,
    getPublishedMany: async (scope, ids) =>
      ids.flatMap((id) => this.publishedData.get(`${scopeKey(scope)}::${id}`) ?? []),
    listPublished: async (scope, query: EntryQuery) => {
      const prefix = `${scopeKey(scope)}::`;
      let rows = [...this.publishedData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
      if (query.contentTypeApiId) {
        rows = rows.filter((r) => r.contentTypeApiId === query.contentTypeApiId);
      }
      if (query.since) rows = rows.filter((r) => r.publishedAt > (query.since as string));
      if (query.afterEntryId !== undefined && query.afterEntryId !== '') {
        const cursor = query.afterEntryId;
        rows = rows.filter((r) => r.entryId > cursor);
      }
      if (query.after) {
        const { publishedAt, entryId } = query.after;
        rows = rows.filter(
          (r) =>
            r.publishedAt > publishedAt || (r.publishedAt === publishedAt && r.entryId > entryId),
        );
      }
      // Keyset paging (afterEntryId, '' = from the start) orders by entryId
      // (stable cursor); the default is publishedAt asc so a `since` cursor
      // advances deterministically. Explicit `order` overrides in runEntryQuery.
      rows.sort((a, b) =>
        query.afterEntryId !== undefined
          ? a.entryId < b.entryId
            ? -1
            : a.entryId > b.entryId
              ? 1
              : 0
          : a.publishedAt < b.publishedAt
            ? -1
            : a.publishedAt > b.publishedAt
              ? 1
              : a.entryId < b.entryId
                ? -1
                : a.entryId > b.entryId
                  ? 1
                  : 0,
      );
      const filtered = runEntryQuery(
        rows,
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
    searchPublished: async (scope, query, opts) => {
      // Mirrors the Postgres adapter's websearch_to_tsquery semantics: every
      // term must be present; score is total term frequency across all string
      // field values (all locales).
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      if (terms.length === 0) return [];
      const prefix = `${scopeKey(scope)}::`;
      const hits: { entryId: string; score: number }[] = [];
      for (const [key, row] of this.publishedData.entries()) {
        if (!key.startsWith(prefix)) continue;
        const texts: string[] = [];
        for (const localized of Object.values(row.fields)) {
          for (const value of Object.values(localized)) {
            if (typeof value === 'string') texts.push(value.toLowerCase());
          }
        }
        const haystack = texts.join(' ');
        let score = 0;
        let matchedAll = true;
        for (const term of terms) {
          let count = 0;
          let at = haystack.indexOf(term);
          while (at !== -1) {
            count += 1;
            at = haystack.indexOf(term, at + term.length);
          }
          if (count === 0) {
            matchedAll = false;
            break;
          }
          score += count;
        }
        if (matchedAll) hits.push({ entryId: row.entryId, score });
      }
      return hits
        .sort((a, b) => b.score - a.score || a.entryId.localeCompare(b.entryId))
        .slice(0, opts.topK);
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
    getPublishedMany: async (scope, ids) =>
      ids.flatMap((id) => this.publishedAssetData.get(`${scopeKey(scope)}::${id}`) ?? []),
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
        // Stamped from the injectable time source (like the real adapter's
        // DB default) so retention tests can control record age.
        createdAt: new Date(this.nowMs()).toISOString(),
      });
    },
    listDeliveries: async (_scope, webhookId, opts) =>
      this.webhookDeliveries
        .filter((d) => d.webhookId === webhookId)
        .sort((a, b) => b.id - a.id)
        .slice(0, opts?.limit ?? 50),
    deleteDeliveriesBefore: async (before, limit) => {
      const cutoff = before.toISOString();
      let deleted = 0;
      for (let i = this.webhookDeliveries.length - 1; i >= 0 && deleted < limit; i--) {
        if ((this.webhookDeliveries[i]?.createdAt ?? '') < cutoff) {
          this.webhookDeliveries.splice(i, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
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
    touchLastUsed: async (id, at) => {
      const existing = this.apiKeyData.get(id);
      if (existing) {
        this.apiKeyData.set(id, { ...existing, lastUsedAt: at.toISOString() });
      }
    },
  };

  private readonly roleData = new Map<string, Role>();

  readonly roles: RoleRepo = {
    save: async (role) => {
      this.roleData.set(`${role.spaceId}::${role.id}`, role);
    },
    get: async (spaceId, id) => this.roleData.get(`${spaceId}::${id}`) ?? null,
    list: async (spaceId) => [...this.roleData.values()].filter((r) => r.spaceId === spaceId),
    delete: async (spaceId, id) => {
      this.roleData.delete(`${spaceId}::${id}`);
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

  private readonly releaseData = new Map<string, Release>();
  private readonly releaseItemData = new Map<string, ReleaseItem[]>();

  readonly releases: ReleaseRepo = {
    create: async (scope, release) => {
      this.releaseData.set(`${scopeKey(scope)}::${release.id}`, release);
      this.releaseItemData.set(`${scopeKey(scope)}::${release.id}`, []);
    },
    get: async (scope, id) => this.releaseData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.releaseData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    save: async (scope, release) => {
      this.releaseData.set(`${scopeKey(scope)}::${release.id}`, release);
    },
    delete: async (scope, id) => {
      this.releaseData.delete(`${scopeKey(scope)}::${id}`);
      this.releaseItemData.delete(`${scopeKey(scope)}::${id}`);
    },
    addItem: async (scope, releaseId, item) => {
      const key = `${scopeKey(scope)}::${releaseId}`;
      const items = (this.releaseItemData.get(key) ?? []).filter(
        (i) => i.entityId !== item.entityId,
      );
      items.push(item);
      this.releaseItemData.set(key, items);
    },
    removeItem: async (scope, releaseId, entityId) => {
      const key = `${scopeKey(scope)}::${releaseId}`;
      this.releaseItemData.set(
        key,
        (this.releaseItemData.get(key) ?? []).filter((i) => i.entityId !== entityId),
      );
    },
    listItems: async (scope, releaseId) =>
      this.releaseItemData.get(`${scopeKey(scope)}::${releaseId}`) ?? [],
  };

  private readonly scheduledActionData = new Map<string, ScopedScheduledAction>();

  readonly scheduledActions: ScheduledActionRepo = {
    create: async (scope, action) => {
      this.scheduledActionData.set(`${scopeKey(scope)}::${action.id}`, { scope, action });
    },
    get: async (scope, id) =>
      this.scheduledActionData.get(`${scopeKey(scope)}::${id}`)?.action ?? null,
    list: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.scheduledActionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v.action)
        .filter((a) => !query?.status || a.status === query.status);
    },
    save: async (scope, action) => {
      this.scheduledActionData.set(`${scopeKey(scope)}::${action.id}`, { scope, action });
    },
    findDue: async (now, limit = 100) =>
      [...this.scheduledActionData.values()]
        .filter((r) => r.action.status === 'pending' && r.action.scheduledFor <= now)
        .sort((a, b) => (a.action.scheduledFor < b.action.scheduledFor ? -1 : 1))
        .slice(0, limit),
  };

  private readonly agentReviewData = new Map<string, AgentReview>();

  readonly agentReviews: AgentReviewRepo = {
    create: async (scope, review) => {
      this.agentReviewData.set(`${scopeKey(scope)}::${review.id}`, review);
    },
    get: async (scope, id) => this.agentReviewData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope, query) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.agentReviewData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((r) => !query?.status || r.status === query.status)
        .filter((r) => !query?.entryId || r.entryId === query.entryId)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
        .slice(0, Math.min(query?.limit ?? 100, 1000));
    },
    decide: async (scope, id, decision) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (!review || review.status !== 'pending') return false;
      this.agentReviewData.set(key, {
        ...review,
        status: decision.status,
        decidedAt: decision.decidedAt,
        decidedBy: decision.decidedBy,
      });
      return true;
    },
    markAwaiting: async (scope, id) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (!review) return 'pending';
      if (review.status !== 'pending' || review.awaiting) return review.status;
      this.agentReviewData.set(key, { ...review, awaiting: true });
      return 'armed';
    },
    clearAwaiting: async (scope, id) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (review) this.agentReviewData.set(key, { ...review, awaiting: false });
    },
    markApplied: async (scope, id, at) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (!review || review.appliedAt) return false;
      this.agentReviewData.set(key, { ...review, appliedAt: at });
      return true;
    },
    clearApplied: async (scope, id) => {
      const key = `${scopeKey(scope)}::${id}`;
      const review = this.agentReviewData.get(key);
      if (review) this.agentReviewData.set(key, { ...review, appliedAt: undefined });
    },
  };

  private readonly agentScheduleData = new Map<string, { scope: Scope; schedule: AgentSchedule }>();

  readonly agentSchedules: AgentScheduleRepo = {
    create: async (scope, schedule) => {
      this.agentScheduleData.set(`${scopeKey(scope)}::${schedule.id}`, { scope, schedule });
    },
    get: async (scope, id) =>
      this.agentScheduleData.get(`${scopeKey(scope)}::${id}`)?.schedule ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.agentScheduleData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v.schedule)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    save: async (scope, schedule) => {
      this.agentScheduleData.set(`${scopeKey(scope)}::${schedule.id}`, { scope, schedule });
    },
    delete: async (scope, id) => {
      this.agentScheduleData.delete(`${scopeKey(scope)}::${id}`);
    },
    findDue: async (now, limit = 100) =>
      [...this.agentScheduleData.values()]
        .filter((r) => r.schedule.enabled && r.schedule.nextRunAt <= now)
        .sort((a, b) => (a.schedule.nextRunAt < b.schedule.nextRunAt ? -1 : 1))
        .slice(0, limit),
    claimNextRun: async (scope, id, expectedNextRunAt, nextRunAt) => {
      const key = `${scopeKey(scope)}::${id}`;
      const row = this.agentScheduleData.get(key);
      if (!row || row.schedule.nextRunAt !== expectedNextRunAt) return false;
      this.agentScheduleData.set(key, { scope, schedule: { ...row.schedule, nextRunAt } });
      return true;
    },
    saveRunState: async (scope, id, state) => {
      const key = `${scopeKey(scope)}::${id}`;
      const row = this.agentScheduleData.get(key);
      if (!row) return;
      this.agentScheduleData.set(key, {
        scope,
        schedule: {
          ...row.schedule,
          lastRunAt: state.lastRunAt,
          cursorEntryId: state.cursorEntryId,
        },
      });
    },
  };

  private readonly commentData = new Map<string, Comment>();

  readonly comments: CommentRepo = {
    create: async (scope, comment) => {
      this.commentData.set(`${scopeKey(scope)}::${comment.id}`, comment);
    },
    get: async (scope, id) => this.commentData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listForEntry: async (scope, entryId) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.commentData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((c) => c.entryId === entryId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    delete: async (scope, id) => {
      this.commentData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly taskData = new Map<string, Task>();

  readonly tasks: TaskRepo = {
    create: async (scope, task) => {
      this.taskData.set(`${scopeKey(scope)}::${task.id}`, task);
    },
    get: async (scope, id) => this.taskData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listForEntry: async (scope, entryId) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.taskData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((t) => t.entryId === entryId)
        .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    },
    save: async (scope, task) => {
      this.taskData.set(`${scopeKey(scope)}::${task.id}`, task);
    },
    delete: async (scope, id) => {
      this.taskData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly workflowData = new Map<string, WorkflowDefinition>();
  private readonly workflowStateData = new Map<string, EntryWorkflowState>();

  readonly workflows: WorkflowRepo = {
    saveDefinition: async (scope, def) => {
      this.workflowData.set(`${scopeKey(scope)}::${def.id}`, def);
    },
    getDefinition: async (scope, id) => this.workflowData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listDefinitions: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.workflowData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    deleteDefinition: async (scope, id) => {
      this.workflowData.delete(`${scopeKey(scope)}::${id}`);
    },
    getState: async (scope, entryId) =>
      this.workflowStateData.get(`${scopeKey(scope)}::${entryId}`) ?? null,
    saveState: async (scope, state) => {
      this.workflowStateData.set(`${scopeKey(scope)}::${state.entryId}`, state);
    },
  };

  private readonly schemeData = new Map<string, ConceptScheme>();
  private readonly conceptData = new Map<string, Concept>();
  private readonly tagData = new Map<string, Tag>();
  private readonly entryMetadataData = new Map<string, EntryMetadata>();

  readonly taxonomy: TaxonomyRepo = {
    createScheme: async (scope, scheme) => {
      this.schemeData.set(`${scopeKey(scope)}::${scheme.id}`, scheme);
    },
    listSchemes: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.schemeData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    getScheme: async (scope, id) => this.schemeData.get(`${scopeKey(scope)}::${id}`) ?? null,
    deleteScheme: async (scope, id) => {
      this.schemeData.delete(`${scopeKey(scope)}::${id}`);
    },
    createConcept: async (scope, concept) => {
      this.conceptData.set(`${scopeKey(scope)}::${concept.id}`, concept);
    },
    getConcept: async (scope, id) => this.conceptData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listConcepts: async (scope, schemeId) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.conceptData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v)
        .filter((c) => !schemeId || c.schemeId === schemeId);
    },
    deleteConcept: async (scope, id) => {
      this.conceptData.delete(`${scopeKey(scope)}::${id}`);
    },
    createTag: async (scope, tag) => {
      this.tagData.set(`${scopeKey(scope)}::${tag.id}`, tag);
    },
    getTag: async (scope, id) => this.tagData.get(`${scopeKey(scope)}::${id}`) ?? null,
    listTags: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.tagData.entries()].filter(([k]) => k.startsWith(prefix)).map(([, v]) => v);
    },
    deleteTag: async (scope, id) => {
      this.tagData.delete(`${scopeKey(scope)}::${id}`);
    },
    getEntryMetadata: async (scope, entryId) =>
      this.entryMetadataData.get(`${scopeKey(scope)}::${entryId}`) ?? null,
    setEntryMetadata: async (scope, entryId, metadata) => {
      this.entryMetadataData.set(`${scopeKey(scope)}::${entryId}`, metadata);
    },
  };

  private readonly auditData: AuditEntry[] = [];

  readonly audit: AuditRepo = {
    append: async (entry) => {
      this.auditData.push(entry);
    },
    list: async (spaceId, query) => {
      let rows = this.auditData.filter((e) => e.spaceId === spaceId);
      if (query.environmentId) rows = rows.filter((e) => e.environmentId === query.environmentId);
      return [...rows].reverse().slice(0, query.limit ?? 100);
    },
  };

  private readonly aiActionData = new Map<string, AIActionDefinition>();

  readonly aiActions: AIActionRepo = {
    create: async (scope, action) => {
      this.aiActionData.set(`${scopeKey(scope)}::${action.id}`, action);
    },
    get: async (scope, id) => this.aiActionData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.aiActionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    delete: async (scope, id) => {
      this.aiActionData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly functionData = new Map<string, FunctionDefinition>();

  readonly functions: FunctionRepo = {
    create: async (scope, fn) => {
      this.functionData.set(`${scopeKey(scope)}::${fn.id}`, fn);
    },
    get: async (scope, id) => this.functionData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.functionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    delete: async (scope, id) => {
      this.functionData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly appExtensionData = new Map<string, AppExtension>();

  readonly appExtensions: AppExtensionRepo = {
    create: async (scope, app) => {
      this.appExtensionData.set(`${scopeKey(scope)}::${app.id}`, app);
    },
    get: async (scope, id) => this.appExtensionData.get(`${scopeKey(scope)}::${id}`) ?? null,
    list: async (scope) => {
      const prefix = `${scopeKey(scope)}::`;
      return [...this.appExtensionData.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([, v]) => v);
    },
    delete: async (scope, id) => {
      this.appExtensionData.delete(`${scopeKey(scope)}::${id}`);
    },
  };

  private readonly previewTokenData = new Map<string, PreviewTokenRecord>();

  readonly previewTokens: PreviewTokenRepo = {
    create: async (record) => {
      this.previewTokenData.set(record.id, record);
    },
    findByHash: async (hashedToken) =>
      [...this.previewTokenData.values()].find(
        (t) => t.hashedToken === hashedToken && !t.revoked,
      ) ?? null,
    revoke: async (id) => {
      const existing = this.previewTokenData.get(id);
      if (existing) this.previewTokenData.set(id, { ...existing, revoked: true });
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
        if (ids.has(row.event.id)) {
          row.relayed = true;
          row.relayedAt = this.nowMs();
        }
      }
    },
    deleteRelayedBefore: async (before, limit) => {
      const cutoff = before.getTime();
      let deleted = 0;
      for (let i = this.outboxData.length - 1; i >= 0 && deleted < limit; i--) {
        const row = this.outboxData[i];
        if (row?.relayed && (row.relayedAt ?? 0) < cutoff) {
          this.outboxData.splice(i, 1);
          deleted += 1;
        }
      }
      return deleted;
    },
  };

  /** The collections a transaction can mutate, for snapshot/rollback. */
  private txCollections(): Map<string, unknown>[] {
    return [
      this.contentTypeData,
      this.entryData,
      this.versionData,
      this.publishedData,
      this.assetData,
      this.publishedAssetData,
      this.referenceData,
      this.releaseData,
      this.releaseItemData,
    ] as Map<string, unknown>[];
  }

  /**
   * Runs `fn` with rollback: the Postgres adapter rolls back on a thrown error,
   * so the fake snapshots every transactional collection up front and restores
   * it if `fn` throws — giving tests real all-or-nothing semantics (e.g. a
   * release that fails mid-publish leaves nothing published).
   */
  async withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T> {
    // Stored values are plain JSON data, so a JSON round-trip deep-clones them
    // (defeating in-place array mutation that a shallow Map copy would miss).
    const clone = <V>(v: V): V => JSON.parse(JSON.stringify(v)) as V;
    const snapshot = this.txCollections().map(
      (m) => [m, [...m.entries()].map(([k, v]) => [k, clone(v)] as const)] as const,
    );
    const outboxSnapshot = [...this.outboxData];
    try {
      return await fn({
        contentTypes: this.contentTypes,
        entries: this.entries,
        assets: this.assets,
        references: this.references,
        releases: this.releases,
        taxonomy: this.taxonomy,
        outbox: this.outbox,
      });
    } catch (err) {
      for (const [m, entries] of snapshot) {
        m.clear();
        for (const [k, v] of entries) m.set(k, v);
      }
      this.outboxData.length = 0;
      this.outboxData.push(...outboxSnapshot);
      throw err;
    }
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

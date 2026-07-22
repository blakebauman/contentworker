import type {
  AgentSchedule,
  ApiKey,
  Asset,
  Comment,
  Concept,
  ConceptScheme,
  ContentType,
  DomainEvent,
  Entry,
  EntryFields,
  EntryMetadata,
  EntryVersion,
  EntryWorkflowState,
  EventType,
  LocaleCode,
  LocalizedValue,
  QueryFilter,
  QueryOrder,
  ReferenceEdge,
  Release,
  ReleaseItem,
  Role,
  ScheduledAction,
  Scope,
  Tag,
  Task,
  Webhook,
  WebhookDelivery,
  WorkflowDefinition,
} from '@cw/domain';

/**
 * The single database seam. The domain and application layers depend only on
 * this interface; the Postgres adapter (and the in-memory test adapter) are the
 * only implementations. No SQL, ORM, or driver type ever crosses this boundary.
 */
export interface ContentStore {
  /** Runs `fn` inside a single transaction. All repos on `tx` share it. */
  withTransaction<T>(fn: (tx: ContentStoreTx) => Promise<T>): Promise<T>;

  readonly spaces: SpaceRepo;
  readonly contentTypes: ContentTypeRepo;
  readonly entries: EntryRepo;
  readonly assets: AssetRepo;
  readonly references: ReferenceRepo;
  readonly webhooks: WebhookRepo;
  readonly auth: AuthRepo;
  readonly roles: RoleRepo;
  readonly agentRuns: AgentRunRepo;
  readonly releases: ReleaseRepo;
  readonly scheduledActions: ScheduledActionRepo;
  readonly agentSchedules: AgentScheduleRepo;
  readonly comments: CommentRepo;
  readonly tasks: TaskRepo;
  readonly workflows: WorkflowRepo;
  readonly taxonomy: TaxonomyRepo;
  readonly audit: AuditRepo;
  readonly aiActions: AIActionRepo;
  readonly functions: FunctionRepo;
  readonly appExtensions: AppExtensionRepo;
  readonly previewTokens: PreviewTokenRepo;
  readonly outbox: OutboxRepo;
}

/**
 * A user-defined function invoked on matching domain events. `eventPattern` is a
 * glob on the event type (`*`, prefix like `entry.*`, or an exact type); the
 * handler is hosted externally and invoked over HTTP. Env-scoped like content.
 */
export interface FunctionDefinition {
  readonly id: string;
  readonly name: string;
  readonly eventPattern: string;
  /** External HTTP endpoint invoked with the event payload. */
  readonly url: string;
  readonly active: boolean;
  readonly createdAt: string;
}

export interface FunctionRepo {
  create(scope: Scope, fn: FunctionDefinition): Promise<void>;
  get(scope: Scope, id: string): Promise<FunctionDefinition | null>;
  list(scope: Scope): Promise<FunctionDefinition[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

/**
 * A UI extension that the admin renders inside a sandboxed iframe. `target`
 * decides where it mounts — a custom `field-editor` (replacing the built-in
 * editor for matching `fieldTypes`) or a `sidebar` widget on the entry editor.
 * The host posts the editing context to the iframe and receives value updates
 * back over `postMessage`. Env-scoped like content.
 */
export interface AppExtension {
  readonly id: string;
  readonly name: string;
  readonly target: 'field-editor' | 'sidebar';
  /** External page rendered in the iframe. */
  readonly entryUrl: string;
  /** For `field-editor`: field types it handles (e.g. `JSON`); empty = any. */
  readonly fieldTypes?: readonly string[];
  readonly active: boolean;
  readonly createdAt: string;
}

export interface AppExtensionRepo {
  create(scope: Scope, app: AppExtension): Promise<void>;
  get(scope: Scope, id: string): Promise<AppExtension | null>;
  list(scope: Scope): Promise<AppExtension[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

/**
 * A persisted, templated, governed AI operation ("AI Action"). The
 * prompt template interpolates `{{variables}}`; an optional `targetField` says
 * which entry field a run writes into. Scoped per environment like content.
 */
export interface AIActionDefinition {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  /** Prompt template with `{{variable}}` placeholders. */
  readonly promptTemplate: string;
  /** Declared variable names the template expects. */
  readonly variables: readonly string[];
  /** Optional entry field the run writes its output into. */
  readonly targetField?: string;
  readonly tier: 'flagship' | 'balanced' | 'fast';
  readonly createdAt: string;
}

export interface AIActionRepo {
  create(scope: Scope, action: AIActionDefinition): Promise<void>;
  get(scope: Scope, id: string): Promise<AIActionDefinition | null>;
  list(scope: Scope): Promise<AIActionDefinition[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

export interface TaxonomyRepo {
  // Concept schemes (vocabularies).
  createScheme(scope: Scope, scheme: ConceptScheme): Promise<void>;
  listSchemes(scope: Scope): Promise<ConceptScheme[]>;
  getScheme(scope: Scope, id: string): Promise<ConceptScheme | null>;
  deleteScheme(scope: Scope, id: string): Promise<void>;
  // Concepts (hierarchical terms within a scheme).
  createConcept(scope: Scope, concept: Concept): Promise<void>;
  getConcept(scope: Scope, id: string): Promise<Concept | null>;
  /** All concepts, or just those in `schemeId` when given. */
  listConcepts(scope: Scope, schemeId?: string): Promise<Concept[]>;
  deleteConcept(scope: Scope, id: string): Promise<void>;
  // Tags (flat labels).
  createTag(scope: Scope, tag: Tag): Promise<void>;
  getTag(scope: Scope, id: string): Promise<Tag | null>;
  listTags(scope: Scope): Promise<Tag[]>;
  deleteTag(scope: Scope, id: string): Promise<void>;
  // Per-entry associations.
  getEntryMetadata(scope: Scope, entryId: string): Promise<EntryMetadata | null>;
  setEntryMetadata(scope: Scope, entryId: string, metadata: EntryMetadata): Promise<void>;
}

export interface CommentRepo {
  create(scope: Scope, comment: Comment): Promise<void>;
  get(scope: Scope, id: string): Promise<Comment | null>;
  /** Comments on an entry, oldest first. */
  listForEntry(scope: Scope, entryId: string): Promise<Comment[]>;
  delete(scope: Scope, id: string): Promise<void>;
}

export interface TaskRepo {
  create(scope: Scope, task: Task): Promise<void>;
  get(scope: Scope, id: string): Promise<Task | null>;
  /** Tasks on an entry, oldest first. */
  listForEntry(scope: Scope, entryId: string): Promise<Task[]>;
  save(scope: Scope, task: Task): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
}

export interface WorkflowRepo {
  saveDefinition(scope: Scope, def: WorkflowDefinition): Promise<void>;
  getDefinition(scope: Scope, id: string): Promise<WorkflowDefinition | null>;
  listDefinitions(scope: Scope): Promise<WorkflowDefinition[]>;
  deleteDefinition(scope: Scope, id: string): Promise<void>;
  /** The workflow position of an entry (null if it has not entered one). */
  getState(scope: Scope, entryId: string): Promise<EntryWorkflowState | null>;
  saveState(scope: Scope, state: EntryWorkflowState): Promise<void>;
}

/** An audit record of one agent workflow execution, including token usage. */
export interface AgentRunRecord {
  readonly id: string;
  readonly workflow: string;
  readonly entryId: string;
  readonly status: string;
  readonly decisions: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly createdAt: string;
}

/** Aggregated token usage — the cost ledger view. */
export interface AgentUsageSummary {
  readonly runs: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export interface AgentRunRepo {
  record(scope: Scope, run: AgentRunRecord): Promise<void>;
  list(scope: Scope, query: { workflow?: string; limit?: number }): Promise<AgentRunRecord[]>;
  usage(scope: Scope, query: { workflow?: string; since?: string }): Promise<AgentUsageSummary>;
}

/** An append-only governance record of a mutating action. */
export interface AuditEntry {
  readonly id: string;
  readonly spaceId: string;
  /** The environment the action targeted, when it was scoped to one. */
  readonly environmentId?: string;
  /** Who acted — the principal kind / api-key id (no user model yet). */
  readonly actor: string;
  /** What happened, e.g. `POST /spaces/:space/environments/:env/entries/:id/published`. */
  readonly action: string;
  /** The kind of entity affected (e.g. `entry`, `release`, `environment-alias`). */
  readonly targetType?: string;
  readonly targetId?: string;
  /** Result status code of the action. */
  readonly status: number;
  readonly at: string;
}

/** Append-only audit trail. Entries are never updated or deleted. */
export interface AuditRepo {
  append(entry: AuditEntry): Promise<void>;
  /** Lists a space's audit entries, newest first. */
  list(spaceId: string, query: { environmentId?: string; limit?: number }): Promise<AuditEntry[]>;
}

/** The denormalized published snapshot of an asset, served by the Delivery API. */
export interface PublishedAsset {
  readonly assetId: string;
  readonly file: Asset['file'];
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly metadata: Asset['metadata'];
  readonly publishedAt: string;
}

export interface AssetRepo {
  get(scope: Scope, id: string): Promise<Asset | null>;
  /** Lists all assets (draft + published) for the media library. */
  list(scope: Scope, query: { limit?: number; skip?: number }): Promise<Asset[]>;
  create(scope: Scope, asset: Asset): Promise<void>;
  save(scope: Scope, asset: Asset): Promise<void>;
  putPublished(scope: Scope, snapshot: PublishedAsset): Promise<void>;
  removePublished(scope: Scope, id: string): Promise<void>;
  getPublished(scope: Scope, id: string): Promise<PublishedAsset | null>;
  listPublished(scope: Scope, query: { limit?: number; skip?: number }): Promise<PublishedAsset[]>;
}

export interface AuthRepo {
  createApiKey(key: ApiKey): Promise<void>;
  /** Resolve an API key by the hash of its presented token. */
  findByHash(hashedToken: string): Promise<ApiKey | null>;
  list(spaceId: string): Promise<ApiKey[]>;
  revoke(id: string): Promise<void>;
  /** Best-effort stamp of last successful use (does not fail auth). */
  touchLastUsed(id: string, at: Date): Promise<void>;
}

/** Expiring, entry-scoped tokens for shareable preview links. */
export interface PreviewTokenRecord {
  readonly id: string;
  readonly spaceId: string;
  readonly environmentId: string;
  readonly entryId: string;
  readonly hashedToken: string;
  readonly expiresAt: Date;
  readonly revoked: boolean;
}

export interface PreviewTokenRepo {
  create(record: PreviewTokenRecord): Promise<void>;
  findByHash(hashedToken: string): Promise<PreviewTokenRecord | null>;
  revoke(id: string): Promise<void>;
}

/** Custom roles (granular RBAC) — space-scoped, referenced by API keys. */
export interface RoleRepo {
  /** Creates or replaces (by id) a role. */
  save(role: Role): Promise<void>;
  get(spaceId: string, id: string): Promise<Role | null>;
  list(spaceId: string): Promise<Role[]>;
  delete(spaceId: string, id: string): Promise<void>;
}

/** The transactional view of the store handed to `withTransaction`. */
export interface ContentStoreTx {
  readonly contentTypes: ContentTypeRepo;
  readonly entries: EntryRepo;
  readonly assets: AssetRepo;
  readonly references: ReferenceRepo;
  readonly releases: ReleaseRepo;
  readonly outbox: OutboxRepo;
}

export interface ReleaseRepo {
  create(scope: Scope, release: Release): Promise<void>;
  get(scope: Scope, id: string): Promise<Release | null>;
  list(scope: Scope): Promise<Release[]>;
  /** Persists the updated release aggregate (status/publishedAt). */
  save(scope: Scope, release: Release): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
  /** Adds (or replaces, by entityId) a member. */
  addItem(scope: Scope, releaseId: string, item: ReleaseItem): Promise<void>;
  removeItem(scope: Scope, releaseId: string, entityId: string): Promise<void>;
  listItems(scope: Scope, releaseId: string): Promise<ReleaseItem[]>;
}

/** A due scheduled action paired with the scope it belongs to (the worker polls
 *  across all scopes, so `findDue` carries scope with each record). */
export interface ScopedScheduledAction {
  readonly scope: Scope;
  readonly action: ScheduledAction;
}

export interface ScheduledActionRepo {
  create(scope: Scope, action: ScheduledAction): Promise<void>;
  get(scope: Scope, id: string): Promise<ScheduledAction | null>;
  list(scope: Scope, query?: { status?: string }): Promise<ScheduledAction[]>;
  save(scope: Scope, action: ScheduledAction): Promise<void>;
  /** Pending actions due at/ before `now`, across every scope, oldest first. */
  findDue(now: string, limit?: number): Promise<ScopedScheduledAction[]>;
}

/** A due agent schedule paired with its scope (cross-scope worker poll). */
export interface ScopedAgentSchedule {
  readonly scope: Scope;
  readonly schedule: AgentSchedule;
}

export interface AgentScheduleRepo {
  create(scope: Scope, schedule: AgentSchedule): Promise<void>;
  get(scope: Scope, id: string): Promise<AgentSchedule | null>;
  list(scope: Scope): Promise<AgentSchedule[]>;
  save(scope: Scope, schedule: AgentSchedule): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
  /** Enabled schedules due at/before `now`, across every scope, oldest first. */
  findDue(now: string, limit?: number): Promise<ScopedAgentSchedule[]>;
  /**
   * Optimistic claim of one due firing: advances `nextRunAt` from
   * `expectedNextRunAt` to `nextRunAt` iff it still holds that value. Returns
   * false when another runner won the race — concurrent workers (replicas,
   * rolling updates, worker + edge cron) then never double-run a firing.
   */
  claimNextRun(
    scope: Scope,
    id: string,
    expectedNextRunAt: string,
    nextRunAt: string,
  ): Promise<boolean>;
  /** Persists only a run's window cursor — never the user-editable fields, so
   *  a concurrent PATCH can't be clobbered by a completing run. */
  saveRunState(
    scope: Scope,
    id: string,
    state: { lastRunAt: string; cursorEntryId?: string },
  ): Promise<void>;
}

/** Space-level configuration needed for validation and locale fallback. */
export interface SpaceConfig {
  readonly spaceId: string;
  readonly name: string;
  readonly defaultLocale: LocaleCode;
  readonly locales: readonly LocaleCode[];
  /** locale -> fallback locale (null = none). Defaults to the default locale. */
  readonly fallbacks?: Readonly<Record<LocaleCode, LocaleCode | null>>;
}

/** An environment (branch) within a space. */
export interface Environment {
  readonly id: string;
  readonly name: string;
}

/** A repointable pointer to a target environment, used for blue/green serving. */
export interface EnvironmentAlias {
  readonly alias: string;
  readonly targetEnvironmentId: string;
  /** When the alias was last (re)pointed (ISO-8601). */
  readonly updatedAt: string;
}

export interface SpaceRepo {
  getConfig(scope: Scope): Promise<SpaceConfig | null>;
  /** All spaces (admin/provisioning view). */
  list(): Promise<SpaceConfig[]>;
  /** Creates (or replaces) a space's configuration. */
  create(config: SpaceConfig): Promise<void>;
  /** Registers an environment (branch) within a space. */
  createEnvironment(spaceId: string, environmentId: string, name: string): Promise<void>;
  /** Lists a space's environments (branches). */
  listEnvironments(spaceId: string): Promise<Environment[]>;
  /** Creates or repoints an environment alias (atomic blue/green pointer). */
  setAlias(spaceId: string, alias: string, targetEnvironmentId: string, at: string): Promise<void>;
  /** Resolves one alias, or null if the name isn't an alias. */
  getAlias(spaceId: string, alias: string): Promise<EnvironmentAlias | null>;
  /** Lists a space's environment aliases. */
  listAliases(spaceId: string): Promise<EnvironmentAlias[]>;
  /** Removes an alias (the target environment is untouched). */
  deleteAlias(spaceId: string, alias: string): Promise<void>;
}

export interface ContentTypeRepo {
  get(scope: Scope, apiId: string): Promise<ContentType | null>;
  list(scope: Scope): Promise<ContentType[]>;
  /** Upserts the definition at its version. */
  save(scope: Scope, contentType: ContentType): Promise<void>;
}

/** A draft entry together with the field values of its current version. */
export interface EntryWithFields {
  readonly entry: Entry;
  readonly fields: EntryFields;
}

/** The denormalized published snapshot served by the Delivery API. */
export interface PublishedEntry {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  readonly version: number;
  readonly fields: EntryFields;
  readonly publishedAt: string;
  /** Taxonomy associations captured at publish time (tags + concepts). */
  readonly metadata?: EntryMetadata;
}

export interface EntryQuery {
  readonly contentTypeApiId?: string;
  readonly limit?: number;
  readonly skip?: number;
  /** Delta cursor — only entries published strictly after this ISO timestamp. */
  readonly since?: string;
  /**
   * Keyset cursor — only entries with `entryId` strictly greater, ordered by
   * `entryId` (`''` = from the start, still entryId-ordered). IDs are UUIDv7
   * (time-ordered), so paging with this cursor is stable under concurrent
   * publishes/unpublishes, unlike `skip` (used by the resumable reindex job).
   */
  readonly afterEntryId?: string;
  /**
   * Compound keyset cursor in publish order: only entries strictly after
   * `(publishedAt, entryId)` — i.e. published later, or published at the same
   * instant with a greater entry id. Matches the default
   * `publishedAt, entryId` ordering, so paging is exact across
   * same-transaction publishes that share a publish instant (used by agent
   * schedules' delta windows).
   */
  readonly after?: { readonly publishedAt: string; readonly entryId: string };
  /** Field-level predicates (all must match). `field` is a field apiId or `sys.*`. */
  readonly filters?: readonly QueryFilter[];
  /** Sort keys, applied in order. */
  readonly order?: readonly QueryOrder[];
  /** Projection — return only these field apiIds. */
  readonly select?: readonly string[];
  /** Full-text search across string field values (case-insensitive). */
  readonly search?: string;
  /** Locale used to resolve field values for filtering/ordering/search. */
  readonly locale?: LocaleCode;
}

/** One ranked full-text match from the published read model. */
export interface TextSearchHit {
  readonly entryId: string;
  /** Engine-relative relevance — meaningful only for ordering within one result set. */
  readonly score: number;
}

export interface EntryRepo {
  get(scope: Scope, id: string): Promise<EntryWithFields | null>;
  /** Lists draft/current entries (the Preview read path), newest-affected first. */
  list(scope: Scope, query: EntryQuery): Promise<EntryWithFields[]>;
  /** Persists a new entry and its first version. */
  create(scope: Scope, entry: Entry, version: EntryVersion): Promise<void>;
  /** Persists the updated aggregate plus a new version snapshot. */
  saveVersion(scope: Scope, entry: Entry, version: EntryVersion): Promise<void>;
  /** Updates only the aggregate (status/pointers) — no new version. */
  saveAggregate(scope: Scope, entry: Entry): Promise<void>;

  /** Lists every saved version of an entry, newest first. */
  listVersions(scope: Scope, entryId: string): Promise<EntryVersion[]>;
  /** Reads one specific version snapshot, or null if it doesn't exist. */
  getVersion(scope: Scope, entryId: string, version: number): Promise<EntryVersion | null>;

  /** Writes the published read model for an entry. */
  putPublished(scope: Scope, snapshot: PublishedEntry): Promise<void>;
  removePublished(scope: Scope, entryId: string): Promise<void>;
  getPublished(scope: Scope, id: string): Promise<PublishedEntry | null>;
  listPublished(scope: Scope, query: EntryQuery): Promise<PublishedEntry[]>;
  /**
   * Ranked full-text search over published string field values (all locales).
   * The lexical leg of hybrid search — every query term must match.
   */
  searchPublished(scope: Scope, query: string, opts: { topK: number }): Promise<TextSearchHit[]>;
}

export interface ReferenceRepo {
  /** Replaces all outgoing edges for an entry (called on publish). */
  replaceForEntry(
    scope: Scope,
    fromEntryId: string,
    edges: readonly ReferenceEdge[],
  ): Promise<void>;
  /** Removes all outgoing edges for an entry (called on unpublish/delete). */
  removeForEntry(scope: Scope, fromEntryId: string): Promise<void>;
  /** Edges pointing AT `toId` — i.e. entries that embed it (for invalidation). */
  findReverse(scope: Scope, toId: string): Promise<ReferenceEdge[]>;
  /** Outgoing edges from `fromEntryId`. */
  findForward(scope: Scope, fromEntryId: string): Promise<ReferenceEdge[]>;
}

/** A recorded delivery attempt (a stored WebhookDelivery + id and timestamp). */
export interface WebhookDeliveryRecord extends WebhookDelivery {
  readonly id: number;
  readonly createdAt: string;
}

export interface WebhookRepo {
  create(scope: Scope, webhook: Webhook): Promise<void>;
  get(scope: Scope, id: string): Promise<Webhook | null>;
  list(scope: Scope): Promise<Webhook[]>;
  /** Active webhooks subscribed to a given event type. */
  listByTopic(scope: Scope, type: EventType): Promise<Webhook[]>;
  /** Persists the full updated webhook (the use-case merges changes first). */
  update(scope: Scope, webhook: Webhook): Promise<void>;
  delete(scope: Scope, id: string): Promise<void>;
  recordDelivery(scope: Scope, delivery: WebhookDelivery): Promise<void>;
  /** Recent delivery attempts for a webhook, newest first. */
  listDeliveries(
    scope: Scope,
    webhookId: string,
    opts?: { limit?: number },
  ): Promise<WebhookDeliveryRecord[]>;
}

/** A row in the transactional outbox awaiting relay to the event bus/queue. */
export interface OutboxRecord {
  readonly event: DomainEvent;
}

export interface OutboxRepo {
  /** Appends an event; must be called within the same tx as the state change. */
  append(event: DomainEvent): Promise<void>;
  /** Reads up to `limit` un-relayed events, oldest first. */
  readPending(limit: number): Promise<DomainEvent[]>;
  /** Marks events as relayed so they are not re-published. */
  markRelayed(eventIds: readonly string[]): Promise<void>;
}

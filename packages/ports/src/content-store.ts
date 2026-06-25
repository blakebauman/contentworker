import type {
  ApiKey,
  Asset,
  ContentType,
  DomainEvent,
  Entry,
  EntryFields,
  EntryVersion,
  EventType,
  LocaleCode,
  LocalizedValue,
  ReferenceEdge,
  Scope,
  Webhook,
  WebhookDelivery,
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
  readonly outbox: OutboxRepo;
}

/** The denormalized published snapshot of an asset, served by the Delivery API. */
export interface PublishedAsset {
  readonly assetId: string;
  readonly file: Asset['file'];
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
  readonly publishedAt: string;
}

export interface AssetRepo {
  get(scope: Scope, id: string): Promise<Asset | null>;
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
}

/** The transactional view of the store handed to `withTransaction`. */
export interface ContentStoreTx {
  readonly contentTypes: ContentTypeRepo;
  readonly entries: EntryRepo;
  readonly assets: AssetRepo;
  readonly references: ReferenceRepo;
  readonly outbox: OutboxRepo;
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

export interface SpaceRepo {
  getConfig(scope: Scope): Promise<SpaceConfig | null>;
  /** Creates (or replaces) a space's configuration. */
  create(config: SpaceConfig): Promise<void>;
  /** Registers an environment (branch) within a space. */
  createEnvironment(spaceId: string, environmentId: string, name: string): Promise<void>;
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
}

export interface EntryQuery {
  readonly contentTypeApiId?: string;
  readonly limit?: number;
  readonly skip?: number;
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

  /** Writes the published read model for an entry. */
  putPublished(scope: Scope, snapshot: PublishedEntry): Promise<void>;
  removePublished(scope: Scope, entryId: string): Promise<void>;
  getPublished(scope: Scope, id: string): Promise<PublishedEntry | null>;
  listPublished(scope: Scope, query: EntryQuery): Promise<PublishedEntry[]>;
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

export interface WebhookRepo {
  create(scope: Scope, webhook: Webhook): Promise<void>;
  list(scope: Scope): Promise<Webhook[]>;
  /** Active webhooks subscribed to a given event type. */
  listByTopic(scope: Scope, type: EventType): Promise<Webhook[]>;
  recordDelivery(scope: Scope, delivery: WebhookDelivery): Promise<void>;
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

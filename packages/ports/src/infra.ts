import type { DomainEvent, Scope, Webhook } from '@cw/domain';

/**
 * Infrastructure ports for the async backbone and AI layer. They are defined
 * here so the seams exist from day one (per the architecture's "leave clean
 * seams" rule); adapters are implemented in later phases. The application layer
 * may depend on these interfaces without any concrete infra being present.
 */

/** One message in a batched enqueue. */
export interface QueueMessage {
  readonly payload: unknown;
  readonly delayMs?: number;
  readonly dedupeKey?: string;
}

/** Generic work queue (BullMQ/Redis by default; SQS/NATS swappable). */
export interface Queue {
  enqueue(
    topic: string,
    payload: unknown,
    opts?: { delayMs?: number; dedupeKey?: string },
  ): Promise<void>;
  /**
   * Enqueues many messages in as few backend calls as the adapter allows
   * (Cloudflare `sendBatch`, BullMQ `addBulk`). Same at-least-once and dedupe
   * semantics as {@link enqueue}; callers must not assume atomicity across the
   * whole batch — a crash mid-call may leave a prefix enqueued.
   */
  enqueueMany(topic: string, messages: readonly QueueMessage[]): Promise<void>;
  process(topic: string, handler: (payload: unknown) => Promise<void>): Subscription;
}

/** Pub/sub fan-out of domain events. */
export interface EventBus {
  publish(event: DomainEvent): Promise<void>;
  subscribe(pattern: string, handler: (event: DomainEvent) => Promise<void>): Subscription;
}

export interface Subscription {
  close(): Promise<void>;
}

/** S3-compatible object storage for assets (S3/GCS/Azure/MinIO/R2). */
export interface BlobStore {
  getUploadUrl(
    key: string,
    contentType: string,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  getDownloadUrl(key: string): Promise<string>;
  delete(key: string): Promise<void>;
}

/** Read-through cache for the Delivery API, with tag-based invalidation. */
export interface Cache {
  get(key: string): Promise<string | null>;
  /** Stores `value` under `key`, associated with the given invalidation tags. */
  set(
    key: string,
    value: string,
    opts?: { ttlSeconds?: number; tags?: readonly string[] },
  ): Promise<void>;
  /** Evicts every cached entry associated with `tag`. */
  invalidateTag(tag: string): Promise<void>;
  /**
   * Batch {@link invalidateTag}: adapters dedupe and use their cheapest bulk
   * form (Redis pipeline, parallel KV writes). Idempotent — safe to re-run on
   * a redelivered event.
   */
  invalidateTags(tags: readonly string[]): Promise<void>;
}

export interface WebhookSendResult {
  readonly delivered: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/** Signs and POSTs a webhook payload. Implemented by the worker (HMAC + fetch). */
export interface WebhookSender {
  send(webhook: Webhook, payload: DomainEvent): Promise<WebhookSendResult>;
}

export interface FunctionInvokeResult {
  readonly ok: boolean;
  readonly statusCode?: number;
  readonly error?: string;
}

/** Invokes a user-defined function on an event (HTTP by default; sandbox swappable). */
export interface FunctionInvoker {
  invoke(url: string, event: DomainEvent): Promise<FunctionInvokeResult>;
}

// ---- AI layer seams -------------------------------------------------------

export type ModelTier = 'flagship' | 'balanced' | 'fast';

export interface GenerateRequest {
  system?: string;
  prompt: string;
  tier?: ModelTier;
  maxTokens: number;
  /** When set, the provider must return JSON matching this JSON Schema. */
  outputSchema?: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  /** Parsed object when `outputSchema` was supplied. */
  object?: unknown;
  usage: { inputTokens: number; outputTokens: number };
}

/** Chat/generation provider. Anthropic Claude by default; swappable. */
export interface AIProvider {
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Verdict from a {@link CostGuard} on whether a scope may make an AI call now. */
export interface AiBudgetDecision {
  readonly allowed: boolean;
  /** Which ceiling was hit, when `allowed` is false. */
  readonly reason?: 'requests' | 'tokens';
  /** Seconds until the rolling window frees up (best-effort hint for Retry-After). */
  readonly retryAfterSeconds?: number;
}

/**
 * Per-tenant AI usage governor. The application layer calls {@link consume}
 * before every AI generation and {@link settle} with the observed token usage
 * after — enforcing per-`Scope` request and token ceilings over a rolling
 * window so a single tenant (or a leaked key) cannot drive unbounded provider
 * spend. Backed by Redis when shared state across replicas is needed, or an
 * in-process window for dev/single-node/tests.
 */
export interface CostGuard {
  /** Registers one AI request for the scope and reports whether it is within budget. */
  consume(scope: Scope): Promise<AiBudgetDecision>;
  /** Records observed token usage after a call (counts toward the token ceiling). */
  settle(scope: Scope, tokens: number): Promise<void>;
}

/** Embeddings provider (separate port; Anthropic ships no embeddings API). */
export interface EmbeddingsProvider {
  readonly modelId: string;
  readonly dimensions: number;
  embed(texts: string[], opts?: { taskType?: 'document' | 'query' }): Promise<number[][]>;
}

export interface VectorRow {
  readonly scope: Scope;
  readonly entryId: string;
  readonly locale: string;
  readonly chunkIndex: number;
  readonly chunkText: string;
  readonly embedding: number[];
  readonly entryVersion: number;
}

export interface VectorMatch {
  readonly entryId: string;
  readonly chunkText: string;
  readonly score: number;
}

/** One indexed lexical document per published entry. */
export interface SearchDoc {
  readonly entryId: string;
  readonly contentTypeApiId: string;
  /** Human-readable text per locale (extracted from the entry's fields). */
  readonly textByLocale: Record<string, string>;
  readonly entryVersion: number;
}

/** One ranked lexical match (engine-relative score, ordering-only). */
export interface LexicalSearchHit {
  readonly entryId: string;
  readonly score: number;
}

/**
 * External lexical full-text index over published entries — the at-scale
 * alternative to the store's built-in Postgres FTS. When bound, publishes
 * (and the reindex job) write into it and hybrid search reads its ranking;
 * absent, the lexical leg stays on `EntryRepo.searchPublished`.
 */
export interface SearchIndex {
  /**
   * `refresh: false` defers making the doc searchable until the engine's own
   * refresh cycle — bulk callers (reindex) set it; publish-time indexing
   * defaults to immediate visibility.
   */
  index(scope: Scope, doc: SearchDoc, opts?: { refresh?: boolean }): Promise<void>;
  remove(scope: Scope, entryId: string): Promise<void>;
  search(scope: Scope, query: string, opts: { topK: number }): Promise<LexicalSearchHit[]>;
}

/** Vector store for semantic search / RAG (pgvector by default). */
export interface VectorStore {
  /**
   * Largest `topK` a single query honors, when the backend caps it (e.g.
   * Vectorize: 50 with metadata). Callers clamp their over-fetch to this so a
   * backend limit is an explicit contract, not a silent truncation.
   */
  readonly maxTopK?: number;
  upsert(rows: VectorRow[]): Promise<void>;
  deleteByEntry(scope: Scope, entryId: string): Promise<void>;
  query(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number },
  ): Promise<VectorMatch[]>;
}

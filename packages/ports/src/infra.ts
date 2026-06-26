import type { DomainEvent, Scope, Webhook } from '@cw/domain';

/**
 * Infrastructure ports for the async backbone and AI layer. They are defined
 * here so the seams exist from day one (per the architecture's "leave clean
 * seams" rule); adapters are implemented in later phases. The application layer
 * may depend on these interfaces without any concrete infra being present.
 */

/** Generic work queue (BullMQ/Redis by default; SQS/NATS swappable). */
export interface Queue {
  enqueue(
    topic: string,
    payload: unknown,
    opts?: { delayMs?: number; dedupeKey?: string },
  ): Promise<void>;
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

/** Vector store for semantic search / RAG (pgvector by default). */
export interface VectorStore {
  upsert(rows: VectorRow[]): Promise<void>;
  deleteByEntry(scope: Scope, entryId: string): Promise<void>;
  query(
    scope: Scope,
    embedding: number[],
    opts: { topK: number; minScore?: number },
  ): Promise<VectorMatch[]>;
}

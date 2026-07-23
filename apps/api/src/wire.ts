import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createS3BlobStore } from '@cw/adapter-blob-s3';
import { createOpenAIEmbeddings } from '@cw/adapter-embeddings-openai';
import {
  createRedisAuthRateLimiter,
  createRedisCache,
  createRedisCostGuard,
  createRedisEventBus,
} from '@cw/adapter-redis';
import { createOpenSearchIndex } from '@cw/adapter-search-opensearch';
import { type PostgresClient, createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import { createQdrantStore } from '@cw/adapter-vector-qdrant';
import { REVIEW_DECISION_SIGNAL, reviewWorkflowId } from '@cw/agent-runtime';
import { assertNoFakeAdapters } from '@cw/application';
import type { AppContext, FakeAdapterBinding, RagDeps } from '@cw/application';
import { type AgentReview, type ApiKeyKind, scopesForKind } from '@cw/domain';
import type {
  AIProvider,
  BlobStore,
  Cache,
  Clock,
  ContentStore,
  CostGuard,
  EmbeddingsProvider,
  EventBus,
  GenerateRequest,
  IdGenerator,
} from '@cw/ports';
import {
  FakeBlobStore,
  InMemoryContentStore,
  InMemoryCostGuard,
  InMemoryEventBus,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@cw/test-kit';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import type { AuthRateLimit } from './auth.js';
import { createApiHasher } from './auth.js';
import type { ApiConfig } from './config.js';

const systemClock: Clock = { now: () => new Date() };
// UUIDv7: time-ordered ids → sequential PK inserts and good B-tree locality in Postgres.
const uuidIds: IdGenerator = { newId: () => uuidv7() };

export interface Wired {
  readonly ctx: AppContext;
  readonly rag: RagDeps;
  readonly blob: BlobStore;
  readonly ai: AIProvider;
  /** Live Content API source: Redis pub/sub when configured, else in-memory. */
  readonly bus: EventBus;
  /** Shared failed-auth limiter when Redis is configured; else the in-process one. */
  readonly rateLimiter?: AuthRateLimit;
  /** Delivers review decisions to the durable HITL watcher (Temporal only). */
  readonly signalReview?: (
    review: AgentReview,
    decision: 'approved' | 'rejected',
  ) => Promise<boolean>;
  close(): Promise<void>;
}

/**
 * AIProvider for generation: Azure OpenAI or Anthropic when configured,
 * otherwise a dev stub that returns schema-shaped placeholder values so the
 * generate flow is demoable offline (no key, no network).
 */
function makeAI(fakes: FakeAdapterBinding[]): AIProvider {
  if (process.env.AI_PROVIDER === 'azure-openai') return createAzureOpenAIProvider();
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider();
  fakes.push({
    key: 'ai',
    detail: 'StubAIProvider (placeholder generations) — set ANTHROPIC_API_KEY or AI_PROVIDER',
  });
  return new StubAIProvider(devGenerate);
}

/** Placeholder generation from the requested JSON schema (dev/no-key fallback). */
function devGenerate(req: GenerateRequest): unknown {
  const props =
    (req.outputSchema as { properties?: Record<string, { type?: string; description?: string }> })
      ?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(props)) {
    if (def.type === 'integer' || def.type === 'number') out[key] = 0;
    else if (def.type === 'boolean') out[key] = false;
    else if (/ISO-8601|date/i.test(def.description ?? '')) out[key] = '2024-01-01';
    else out[key] = `Sample ${def.description ?? key}`;
  }
  return out;
}

/** S3 BlobStore when BLOB_BUCKET is set; otherwise a fake (dev/tests). */
function makeBlob(fakes: FakeAdapterBinding[]): BlobStore {
  if (process.env.BLOB_BUCKET) {
    return createS3BlobStore({
      bucket: process.env.BLOB_BUCKET,
      region: process.env.AWS_REGION,
      endpoint: process.env.BLOB_ENDPOINT,
      forcePathStyle: process.env.BLOB_FORCE_PATH_STYLE === 'true',
      publicBaseUrl: process.env.BLOB_PUBLIC_BASE_URL,
    });
  }
  fakes.push({
    key: 'blob',
    detail: 'FakeBlobStore (uploads are lost on restart) — set BLOB_BUCKET',
  });
  return new FakeBlobStore();
}

/** Builds RAG deps (embeddings + vector store) for the Delivery search endpoint. */
function makeRag(
  databaseUrl: string | undefined,
  fakes: FakeAdapterBinding[],
  pgClient?: PostgresClient,
): RagDeps {
  const provider = process.env.EMBEDDINGS_PROVIDER;
  const dim = Number(process.env.EMBEDDINGS_DIM ?? 1536);
  // An explicit EMBEDDINGS_PROVIDER=local is informed consent to hash-based
  // embeddings; only the silent default (unset/unknown) is flagged as a fake.
  if (provider !== 'azure-openai' && provider !== 'openai' && provider !== 'local') {
    fakes.push({
      key: 'embeddings',
      detail:
        'hash-based embeddings (semantic search returns noise) — set EMBEDDINGS_PROVIDER=azure-openai or =openai (any OpenAI-compatible endpoint), or =local to accept explicitly',
    });
  }
  const embeddings: EmbeddingsProvider =
    provider === 'azure-openai'
      ? createAzureOpenAIEmbeddings()
      : provider === 'openai'
        ? createOpenAIEmbeddings({ dimensions: dim })
        : new LocalEmbeddingsProvider(dim);
  const vectors =
    process.env.VECTOR_PROVIDER === 'qdrant'
      ? createQdrantStore({ dimensions: embeddings.dimensions, modelId: embeddings.modelId })
      : databaseUrl
        ? // Share the content store's pool — one pool per process, not two.
          createPgVectorStore(pgClient ?? databaseUrl, {
            dimensions: embeddings.dimensions,
            modelId: embeddings.modelId,
          })
        : new InMemoryVectorStore();
  // External lexical leg (BM25 at scale); absent → Postgres FTS, still real.
  const searchIndex =
    process.env.SEARCH_PROVIDER === 'opensearch' ? createOpenSearchIndex() : undefined;
  return { embeddings, vectors, searchIndex };
}

/**
 * Builds the per-tenant AI budget governor: Redis-backed (shared across
 * replicas) when Redis is configured, else an in-process window for
 * dev/single-node. Returns `undefined` — unmetered — when either ceiling is set
 * to 0 to explicitly disable metering.
 */
function makeCostGuard(config: ApiConfig, redis?: Redis): CostGuard | undefined {
  const limits = config.aiBudget;
  if (!limits || limits.maxRequests <= 0 || limits.maxTokens <= 0) return undefined;
  return redis ? createRedisCostGuard(redis, limits) : new InMemoryCostGuard(limits);
}

/**
 * Review-decision signaler for AGENT_RUNTIME=temporal: delivers a human
 * decision to the durable review watcher as a Temporal Signal. The client is
 * created lazily on first use (most API processes never decide a review), and
 * any failure returns false — the decision use-case then applies directly,
 * which the exactly-once marker makes safe.
 */
function makeSignalReview(): Wired['signalReview'] {
  if (process.env.AGENT_RUNTIME !== 'temporal') return undefined;
  let clientPromise: Promise<import('@temporalio/client').Client> | undefined;
  return async (review, decision) => {
    try {
      const { Client, Connection } = await import('@temporalio/client');
      clientPromise ??= Connection.connect({
        address: process.env.TEMPORAL_ADDRESS ?? 'localhost:7233',
      }).then(
        (connection) =>
          new Client({ connection, namespace: process.env.TEMPORAL_NAMESPACE ?? 'default' }),
      );
      const client = await clientPromise;
      await client.workflow
        .getHandle(reviewWorkflowId(review.id))
        .signal(REVIEW_DECISION_SIGNAL, decision);
      return true;
    } catch {
      return false;
    }
  };
}

/**
 * The composition root: the one place adapters are bound to ports. Selects the
 * Postgres store + Redis cache when their URLs are set, otherwise in-memory
 * equivalents seeded with a default space (for dev, tests, and demos).
 */
export function wire(config: ApiConfig): Wired {
  const hasher = createApiHasher(config.tokenPepper);
  const closers: (() => Promise<void>)[] = [];

  // A cache is only attached when Redis is configured — the worker invalidates
  // it on publish. In pure in-memory dev (no worker), reads stay uncached/fresh.
  let cache: Cache | undefined;
  // The Live Content API subscribes to this bus; the worker publishes to it.
  // Redis pub/sub connects the two processes; in-memory is a single-process stub.
  let bus: EventBus = new InMemoryEventBus();
  let redis: Redis | undefined;
  if (config.redisUrl) {
    redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    cache = createRedisCache(redis);
    const redisBus = createRedisEventBus(redis);
    bus = redisBus;
    closers.push(() => redisBus.close());
    closers.push(async () => void redis?.disconnect());
  }
  const costGuard = makeCostGuard(config, redis);
  const ttlRaw = Number(process.env.DELIVERY_CACHE_TTL_SECONDS);
  const deliveryCacheTtlSeconds = Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
  // Share the failed-auth window across replicas when Redis is present, so an
  // attacker can't multiply the budget by spreading attempts across pods.
  const rateLimiter: AuthRateLimit | undefined = redis
    ? createRedisAuthRateLimiter(
        redis,
        Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10),
        Number(process.env.AUTH_RATE_LIMIT_WINDOW_MS ?? 60_000),
      )
    : undefined;

  // The store comes first so RAG can share its connection pool (postgres.js
  // connects lazily — nothing dials the database until a query runs, so the
  // fail-fast fake-adapter guard below still fires before any I/O).
  const pgStore = config.databaseUrl ? createPostgresStore(config.databaseUrl) : undefined;
  if (pgStore) closers.push(() => pgStore.close());

  // Fail fast when a real database would run behind dev fakes: build the
  // AI/blob/RAG bindings first, then refuse to boot on any unallowed fake.
  const fakes: FakeAdapterBinding[] = [];
  const rag = makeRag(config.databaseUrl, fakes, pgStore?.sql);
  const blob = makeBlob(fakes);
  const ai = makeAI(fakes);
  assertNoFakeAdapters({
    persistent: Boolean(config.databaseUrl),
    allowFakeAdapters: process.env.ALLOW_FAKE_ADAPTERS,
    fakes,
  });

  if (pgStore) {
    const store = pgStore;
    return {
      ctx: { store, clock: systemClock, ids: uuidIds, cache, deliveryCacheTtlSeconds, costGuard },
      rag,
      blob,
      ai,
      bus,
      rateLimiter,
      signalReview: makeSignalReview(),
      close: async () => {
        for (const c of closers) await c();
      },
    };
  }

  const store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: config.seed.spaceId,
    defaultLocale: config.seed.defaultLocale,
    locales: config.seed.locales,
  });
  const ctx: AppContext = {
    store: store as ContentStore,
    clock: systemClock,
    ids: uuidIds,
    cache,
    deliveryCacheTtlSeconds,
    costGuard,
  };
  // Seed dev API keys (synchronously) so the dev tokens authenticate through the
  // real auth path with no startup race.
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    store.seedApiKey({
      id: uuidIds.newId(),
      spaceId: config.seed.spaceId,
      kind,
      name: `dev-${kind}`,
      hashedToken: hasher.hash(token),
      scopes: scopesForKind(kind),
      revoked: false,
    });
  }
  return {
    ctx,
    rag,
    blob,
    ai,
    bus,
    rateLimiter,
    signalReview: makeSignalReview(),
    close: async () => {
      for (const c of closers) await c();
    },
  };
}

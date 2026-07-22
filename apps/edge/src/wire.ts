import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createS3BlobStore } from '@cw/adapter-blob-s3';
import { createKvCache } from '@cw/adapter-cache-kv';
import { createOpenAIEmbeddings } from '@cw/adapter-embeddings-openai';
import { createCfQueueProducer } from '@cw/adapter-queue-cf';
import { createOpenSearchIndex } from '@cw/adapter-search-opensearch';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createQdrantStore } from '@cw/adapter-vector-qdrant';
import { createVectorizeStore } from '@cw/adapter-vector-vectorize';
import { InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import { createApiHasher } from '@cw/api/auth';
import { type ApiConfig, loadConfig } from '@cw/api/config';
import {
  type AgentRunner,
  type AppContext,
  EVENTS_TOPIC,
  type FakeAdapterBinding,
  type PublishAgentsConfig,
  type RagDeps,
  assertNoFakeAdapters,
} from '@cw/application';
import { type ApiKeyKind, scopesForKind } from '@cw/domain';
import type {
  AIProvider,
  BlobStore,
  Cache,
  ContentStore,
  EmbeddingsProvider,
  EventBus,
  GenerateRequest,
  IdGenerator,
  Queue as QueuePort,
  SearchIndex,
  VectorStore,
} from '@cw/ports';
import {
  FakeBlobStore,
  InMemoryContentStore,
  InMemoryEventBus,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@cw/test-kit';
import { v7 as uuidv7 } from 'uuid';
import { CloudflareWorkflowsAgentRuntime } from './agents/runtime.js';
import { createDoCostGuard } from './do/cost-guard.js';
import type { EdgeEnv } from './env.js';

const clock = { now: () => new Date() };
// UUIDv7 (time-ordered) — consistent with the rest of the platform's PKs.
const ids: IdGenerator = { newId: () => uuidv7() };

export interface EdgeWired {
  readonly ctx: AppContext;
  readonly config: ApiConfig;
  readonly rag: RagDeps;
  readonly blob: BlobStore;
  readonly ai: AIProvider;
  readonly bus: EventBus;
  readonly cache?: Cache;
  /** Producer onto the cw-events queue; absent when the binding is not set. */
  readonly queue?: QueuePort;
  /** True when backed by Postgres (Hyperdrive/DATABASE_URL) vs in-memory demo. */
  readonly persistent: boolean;
  /** Closes per-request resources (DB connections). Safe to call once. */
  close(): Promise<void>;
}

/**
 * Composition root for the Cloudflare deployment. Mirrors apps/api/src/wire.ts
 * with Cloudflare-native adapters: Hyperdrive→Postgres, KV cache, Queues
 * producer, Vectorize vectors, R2 via the S3 API. Called once per request /
 * queue batch / cron tick — postgres.js sockets cannot be shared across Worker
 * requests, so connections are opened and closed per invocation (Hyperdrive
 * pools upstream, keeping the connect cheap). The in-memory fallback is
 * memoized at module scope so demo-mode data survives across requests within
 * an isolate.
 */
export function wireEdge(env: EdgeEnv): EdgeWired {
  const config = loadConfig(env as unknown as NodeJS.ProcessEnv);
  const closers: (() => Promise<void>)[] = [];

  // Hyperdrive is the pooler: a direct DATABASE_URL must use Neon's UNPOOLED
  // endpoint. The pooled (-pooler) host runs PgBouncer transaction pooling,
  // which silently breaks withTransaction connection pinning and the outbox's
  // FOR UPDATE SKIP LOCKED claiming. Checked only when DATABASE_URL is what
  // we'd actually connect with (no Hyperdrive binding).
  if (!env.HYPERDRIVE && env.DATABASE_URL?.includes('-pooler.')) {
    throw new Error(
      'DATABASE_URL points at a pooled Neon endpoint (-pooler host); use the unpooled endpoint',
    );
  }
  const connectionString = env.HYPERDRIVE?.connectionString ?? env.DATABASE_URL;
  const cache = env.KV_CACHE ? createKvCache(env.KV_CACHE) : undefined;
  const queue = env.EVENTS_QUEUE
    ? createCfQueueProducer({ [EVENTS_TOPIC]: env.EVENTS_QUEUE })
    : undefined;

  let store: ContentStore;
  if (connectionString) {
    // fetchTypes off: no runtime pg_type discovery round-trips through the
    // Hyperdrive pool; our schema needs none of it.
    const pg = createPostgresStore(connectionString, { max: 5, fetchTypes: false });
    closers.push(() => pg.close());
    store = pg;
  } else {
    store = inMemoryStore(config);
  }

  // Fail fast when a persistent (Hyperdrive/DATABASE_URL) deployment would run
  // behind dev fakes — mirror of the Node composition roots' guard.
  const fakes: FakeAdapterBinding[] = [];
  const rag = makeRag(env, fakes);
  const blob = makeBlob(env, fakes);
  const ai = makeAI(env, fakes);
  assertNoFakeAdapters({
    persistent: Boolean(connectionString),
    allowFakeAdapters: env.ALLOW_FAKE_ADAPTERS,
    fakes,
  });
  // Meter AI spend per space via the CostGuard Durable Object (shared across
  // isolates/colos). Absent binding → unmetered (demo/dev).
  const costGuard = env.AI_BUDGET ? createDoCostGuard(env.AI_BUDGET) : undefined;
  const ctx: AppContext = { store, clock, ids, cache, costGuard };

  return {
    ctx,
    config,
    rag,
    blob,
    ai,
    bus: new InMemoryEventBus(),
    cache,
    queue,
    persistent: Boolean(connectionString),
    close: async () => {
      for (const c of closers) await c();
    },
  };
}

/** On-publish agent configuration (used by the queue consumer). */
export function agentConfigFromEnv(env: EdgeEnv): PublishAgentsConfig {
  return {
    enrich: env.AGENTS_ENRICH === 'true',
    moderate: env.AGENTS_MODERATE === 'true',
    autoApply: env.AGENTS_AUTO_APPLY === 'true',
  };
}

/**
 * Agent runtime for on-publish runs: Cloudflare Workflows when selected
 * (durable), else in-process (non-durable) — mirroring the Node worker's
 * AGENT_RUNTIME switch.
 */
export function makeAgents(env: EdgeEnv, ctx: AppContext, ai: AIProvider): AgentRunner | undefined {
  const cfg = agentConfigFromEnv(env);
  if (!cfg.enrich && !cfg.moderate) return undefined;
  if (env.AGENT_RUNTIME === 'cloudflare-workflows' && env.AGENT_WF) {
    return new CloudflareWorkflowsAgentRuntime(env.AGENT_WF, ids);
  }
  return new InProcessAgentRuntime(makeActivities({ ctx, ai }));
}

/** AI provider: same policy as the Node composition roots. */
export function makeAI(env: EdgeEnv, fakes?: FakeAdapterBinding[]): AIProvider {
  if (env.AI_PROVIDER === 'azure-openai') return createAzureOpenAIProvider();
  if (env.ANTHROPIC_API_KEY) {
    return createAnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    });
  }
  fakes?.push({
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

/** R2 via the S3 API when BLOB_BUCKET is set (explicit credentials); else fake. */
function makeBlob(env: EdgeEnv, fakes: FakeAdapterBinding[]): BlobStore {
  if (env.BLOB_BUCKET) {
    return createS3BlobStore({
      bucket: env.BLOB_BUCKET,
      region: env.AWS_REGION ?? 'auto',
      endpoint: env.BLOB_ENDPOINT,
      forcePathStyle: env.BLOB_FORCE_PATH_STYLE === 'true',
      publicBaseUrl: env.BLOB_PUBLIC_BASE_URL,
      ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: env.AWS_ACCESS_KEY_ID,
              secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  fakes.push({
    key: 'blob',
    detail: 'FakeBlobStore (uploads are lost) — set BLOB_BUCKET + R2 S3-API credentials',
  });
  return new FakeBlobStore();
}

/** Embeddings by env; vectors on Vectorize when bound, else in-memory. */
function makeRag(env: EdgeEnv, fakes: FakeAdapterBinding[]): RagDeps {
  // Explicit EMBEDDINGS_PROVIDER=local is informed consent to hash embeddings;
  // only the silent default (unset/unknown) counts as a fake.
  const provider = env.EMBEDDINGS_PROVIDER;
  const dim = Number(env.EMBEDDINGS_DIM ?? 1536);
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
        ? createOpenAIEmbeddings({
            baseUrl: env.EMBEDDINGS_BASE_URL,
            apiKey: env.EMBEDDINGS_API_KEY,
            model: env.EMBEDDINGS_MODEL,
            dimensions: dim,
          })
        : new LocalEmbeddingsProvider(dim);
  const useQdrant = env.VECTOR_PROVIDER === 'qdrant';
  if (!env.VECTORIZE && !useQdrant) {
    fakes.push({
      key: 'vectors',
      detail:
        'in-memory vector store (per-isolate, non-durable) — bind VECTORIZE or set VECTOR_PROVIDER=qdrant',
    });
  }
  // Qdrant/OpenSearch adapters are memoized at module scope: wireEdge runs per
  // request, and their lazy ensure-collection/index round-trips should happen
  // once per isolate, not once per request (env vars are stable per isolate).
  const vectors: VectorStore = useQdrant
    ? memoQdrantStore(env, embeddings.dimensions, embeddings.modelId)
    : env.VECTORIZE
      ? createVectorizeStore(env.VECTORIZE, {
          dimensions: embeddings.dimensions,
          modelId: embeddings.modelId,
        })
      : memoInMemoryVectors();
  const searchIndex = env.SEARCH_PROVIDER === 'opensearch' ? memoOpenSearchIndex(env) : undefined;
  return { embeddings, vectors, searchIndex };
}

let memoQdrant: VectorStore | undefined;
let memoOpenSearch: SearchIndex | undefined;

function memoQdrantStore(env: EdgeEnv, dimensions: number, modelId?: string): VectorStore {
  memoQdrant ??= createQdrantStore({
    url: env.QDRANT_URL,
    apiKey: env.QDRANT_API_KEY,
    collection: env.QDRANT_COLLECTION,
    dimensions,
    modelId,
  });
  return memoQdrant;
}

function memoOpenSearchIndex(env: EdgeEnv): SearchIndex {
  memoOpenSearch ??= createOpenSearchIndex({
    url: env.OPENSEARCH_URL,
    username: env.OPENSEARCH_USERNAME,
    password: env.OPENSEARCH_PASSWORD,
    index: env.OPENSEARCH_INDEX,
  });
  return memoOpenSearch;
}

// ---- module-scope memoization for demo mode --------------------------------
// Workers isolates persist across requests; keeping the in-memory store at
// module scope makes no-database demo deployments behave like the Node dev
// server (create → read works across requests within an isolate).

let memoStore: InMemoryContentStore | undefined;
let memoVectors: InMemoryVectorStore | undefined;

function memoInMemoryVectors(): InMemoryVectorStore {
  memoVectors ??= new InMemoryVectorStore();
  return memoVectors;
}

function inMemoryStore(config: ApiConfig): ContentStore {
  if (memoStore) return memoStore as unknown as ContentStore;
  const store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: config.seed.spaceId,
    defaultLocale: config.seed.defaultLocale,
    locales: config.seed.locales,
  });
  const hasher = createApiHasher(config.tokenPepper);
  const tokens: Record<ApiKeyKind, string> = {
    cma: config.cmaKey,
    cda: config.cdaKey,
    cpa: config.cpaKey,
  };
  for (const [kind, token] of Object.entries(tokens) as [ApiKeyKind, string][]) {
    store.seedApiKey({
      id: ids.newId(),
      spaceId: config.seed.spaceId,
      kind,
      name: `dev-${kind}`,
      hashedToken: hasher.hash(token),
      scopes: scopesForKind(kind),
      revoked: false,
    });
  }
  memoStore = store;
  return store as unknown as ContentStore;
}

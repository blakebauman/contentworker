import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createS3BlobStore } from '@cw/adapter-blob-s3';
import { createRedisCache } from '@cw/adapter-redis';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import type { AppContext, RagDeps } from '@cw/application';
import { type ApiKeyKind, scopesForKind } from '@cw/domain';
import type {
  AIProvider,
  BlobStore,
  Cache,
  Clock,
  ContentStore,
  EmbeddingsProvider,
  GenerateRequest,
  IdGenerator,
} from '@cw/ports';
import {
  FakeBlobStore,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@cw/test-kit';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { sha256Hasher } from './auth.js';
import type { ApiConfig } from './config.js';

const systemClock: Clock = { now: () => new Date() };
// UUIDv7: time-ordered ids → sequential PK inserts and good B-tree locality in Postgres.
const uuidIds: IdGenerator = { newId: () => uuidv7() };

export interface Wired {
  readonly ctx: AppContext;
  readonly rag: RagDeps;
  readonly blob: BlobStore;
  readonly ai: AIProvider;
  close(): Promise<void>;
}

/**
 * AIProvider for generation: Azure OpenAI or Anthropic when configured,
 * otherwise a dev stub that returns schema-shaped placeholder values so the
 * generate flow is demoable offline (no key, no network).
 */
function makeAI(): AIProvider {
  if (process.env.AI_PROVIDER === 'azure-openai') return createAzureOpenAIProvider();
  if (process.env.ANTHROPIC_API_KEY) return createAnthropicProvider();
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
function makeBlob(): BlobStore {
  if (process.env.BLOB_BUCKET) {
    return createS3BlobStore({
      bucket: process.env.BLOB_BUCKET,
      region: process.env.AWS_REGION,
      endpoint: process.env.BLOB_ENDPOINT,
      forcePathStyle: process.env.BLOB_FORCE_PATH_STYLE === 'true',
      publicBaseUrl: process.env.BLOB_PUBLIC_BASE_URL,
    });
  }
  return new FakeBlobStore();
}

/** Builds RAG deps (embeddings + vector store) for the Delivery search endpoint. */
function makeRag(databaseUrl?: string): RagDeps {
  const embeddings: EmbeddingsProvider =
    process.env.EMBEDDINGS_PROVIDER === 'azure-openai'
      ? createAzureOpenAIEmbeddings()
      : new LocalEmbeddingsProvider(Number(process.env.EMBEDDINGS_DIM ?? 1536));
  const vectors = databaseUrl
    ? createPgVectorStore(databaseUrl, {
        dimensions: embeddings.dimensions,
        modelId: embeddings.modelId,
      })
    : new InMemoryVectorStore();
  return { embeddings, vectors };
}

/**
 * The composition root: the one place adapters are bound to ports. Selects the
 * Postgres store + Redis cache when their URLs are set, otherwise in-memory
 * equivalents seeded with a default space (for dev, tests, and demos).
 */
export function wire(config: ApiConfig): Wired {
  const closers: (() => Promise<void>)[] = [];

  // A cache is only attached when Redis is configured — the worker invalidates
  // it on publish. In pure in-memory dev (no worker), reads stay uncached/fresh.
  let cache: Cache | undefined;
  if (config.redisUrl) {
    const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
    cache = createRedisCache(redis);
    closers.push(async () => void redis.disconnect());
  }

  if (config.databaseUrl) {
    const store = createPostgresStore(config.databaseUrl);
    closers.push(() => store.close());
    return {
      ctx: { store, clock: systemClock, ids: uuidIds, cache },
      rag: makeRag(config.databaseUrl),
      blob: makeBlob(),
      ai: makeAI(),
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
  const ctx: AppContext = { store: store as ContentStore, clock: systemClock, ids: uuidIds, cache };
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
      hashedToken: sha256Hasher.hash(token),
      scopes: scopesForKind(kind),
      revoked: false,
    });
  }
  return {
    ctx,
    rag: makeRag(config.databaseUrl),
    blob: makeBlob(),
    ai: makeAI(),
    close: async () => {
      for (const c of closers) await c();
    },
  };
}

import { createHash } from 'node:crypto';
import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import type { AppContext, RagDeps } from '@cw/application';
import type {
  AIProvider,
  Clock,
  ContentStore,
  EmbeddingsProvider,
  Hasher,
  IdGenerator,
} from '@cw/ports';
import { InMemoryContentStore, InMemoryVectorStore, LocalEmbeddingsProvider } from '@cw/test-kit';
import { v7 as uuidv7 } from 'uuid';

const clock: Clock = { now: () => new Date() };
// UUIDv7 (time-ordered) — consistent with the rest of the platform's PKs.
const ids: IdGenerator = { newId: () => uuidv7() };
const hasher: Hasher = { hash: (v) => createHash('sha256').update(v).digest('hex') };

export interface McpDeps {
  readonly ctx: AppContext;
  readonly ai: AIProvider;
  readonly rag: RagDeps;
  readonly hasher: Hasher;
  /** Root token granting all scopes across all spaces. */
  readonly adminToken: string;
}

/**
 * Composition root for the MCP server. Selects the AI/embeddings providers by
 * env (AI_PROVIDER / EMBEDDINGS_PROVIDER) and the store by DATABASE_URL — the
 * same ports the rest of the platform uses, so MCP tools are just another caller.
 */
export function wire(env: NodeJS.ProcessEnv = process.env): McpDeps {
  const store: ContentStore = env.DATABASE_URL
    ? createPostgresStore(env.DATABASE_URL)
    : seededInMemory(env);

  const provider = env.AI_PROVIDER ?? 'anthropic';
  const ai = provider === 'azure-openai' ? createAzureOpenAIProvider() : createAnthropicProvider();

  const embeddings: EmbeddingsProvider =
    env.EMBEDDINGS_PROVIDER === 'azure-openai'
      ? createAzureOpenAIEmbeddings()
      : new LocalEmbeddingsProvider(Number(env.EMBEDDINGS_DIM ?? 1536));
  const vectors = env.DATABASE_URL
    ? createPgVectorStore(env.DATABASE_URL, {
        dimensions: embeddings.dimensions,
        modelId: embeddings.modelId,
      })
    : new InMemoryVectorStore();

  return {
    ctx: { store, clock, ids },
    ai,
    rag: { embeddings, vectors },
    hasher,
    adminToken: env.MCP_TOKEN ?? 'dev-mcp-token',
  };
}

function seededInMemory(env: NodeJS.ProcessEnv): ContentStore {
  const store = new InMemoryContentStore();
  store.seedSpace({
    spaceId: env.SEED_SPACE_ID ?? 'space-1',
    defaultLocale: env.SEED_DEFAULT_LOCALE ?? 'en-US',
    locales: (env.SEED_LOCALES ?? 'en-US').split(',').map((s) => s.trim()),
  });
  return store as ContentStore;
}

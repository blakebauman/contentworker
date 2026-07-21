import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import { InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import { aiBudgetLimits, createHasher } from '@cw/application';
import type { AgentRunner, AppContext, RagDeps } from '@cw/application';
import type {
  AIProvider,
  Clock,
  ContentStore,
  EmbeddingsProvider,
  GenerateRequest,
  Hasher,
  IdGenerator,
} from '@cw/ports';
import {
  InMemoryContentStore,
  InMemoryCostGuard,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  StubAIProvider,
} from '@cw/test-kit';
import { v7 as uuidv7 } from 'uuid';

const clock: Clock = { now: () => new Date() };
// UUIDv7 (time-ordered) — consistent with the rest of the platform's PKs.
const ids: IdGenerator = { newId: () => uuidv7() };

/**
 * AIProvider for the generate_draft tool — same policy as the HTTP API: Azure or
 * Anthropic when configured, otherwise a dev stub returning schema-shaped
 * placeholders so the tool works offline (no key, no network).
 */
function makeAI(env: NodeJS.ProcessEnv): AIProvider {
  if (env.AI_PROVIDER === 'azure-openai') return createAzureOpenAIProvider();
  if (env.ANTHROPIC_API_KEY) return createAnthropicProvider();
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

export interface McpDeps {
  readonly ctx: AppContext;
  readonly ai: AIProvider;
  readonly rag: RagDeps;
  /** Agent-workflow runtime for on-demand agent actions (moderation). */
  readonly agents: AgentRunner;
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

  const ai = makeAI(env);

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

  const limits = aiBudgetLimits(process.env);
  const costGuard = limits ? new InMemoryCostGuard(limits) : undefined;
  const ctx: AppContext = { store, clock, ids, costGuard };
  return {
    ctx,
    ai,
    rag: { embeddings, vectors },
    // On-demand agent actions run in-process (synchronous request/response);
    // the durable Temporal path serves the worker's on-publish runs.
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
    hasher: createHasher(env.TOKEN_PEPPER),
    // Only fall back to the dev token on a non-persistent (in-memory) store, so a
    // real deployment (DATABASE_URL set) without MCP_TOKEN fails closed instead of
    // exposing a world-known wildcard-admin bearer against the live database.
    adminToken: env.MCP_TOKEN ?? (env.DATABASE_URL ? '' : 'dev-mcp-token'),
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

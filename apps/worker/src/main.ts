import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createRedisCache, createRedisQueue } from '@cw/adapter-redis';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import { type AgentRuntime, InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import {
  type AppContext,
  EVENTS_TOPIC,
  type RagDeps,
  dispatchEvent,
  relayOutbox,
} from '@cw/application';
import type { DomainEvent } from '@cw/domain';
import type { AIProvider, Clock, EmbeddingsProvider, IdGenerator } from '@cw/ports';
import { LocalEmbeddingsProvider } from '@cw/test-kit';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { createWebhookSender } from './webhook-sender.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!redisUrl) throw new Error('REDIS_URL is required');

const RELAY_INTERVAL_MS = Number(process.env.RELAY_INTERVAL_MS ?? 1000);

const clock: Clock = { now: () => new Date() };
const ids: IdGenerator = { newId: () => uuidv7() };

/** Builds the RAG deps when EMBEDDINGS_PROVIDER is configured (else undefined). */
function makeRag(connectionString: string): RagDeps | undefined {
  const provider = process.env.EMBEDDINGS_PROVIDER;
  if (!provider) return undefined;
  const embeddings: EmbeddingsProvider =
    provider === 'azure-openai'
      ? createAzureOpenAIEmbeddings()
      : new LocalEmbeddingsProvider(Number(process.env.EMBEDDINGS_DIM ?? 1536));
  const vectors = createPgVectorStore(connectionString, {
    dimensions: embeddings.dimensions,
    modelId: embeddings.modelId,
  });
  return { embeddings, vectors };
}

/** Builds the enrich-on-publish agent runtime when AGENTS_ENRICH is enabled. */
function makeAgents(ctx: AppContext): AgentRuntime | undefined {
  if (process.env.AGENTS_ENRICH !== 'true') return undefined;
  const ai: AIProvider =
    process.env.AI_PROVIDER === 'azure-openai'
      ? createAzureOpenAIProvider()
      : createAnthropicProvider();
  return new InProcessAgentRuntime(makeActivities({ ctx, ai }));
}

async function main() {
  const store = createPostgresStore(databaseUrl as string);
  // BullMQ requires maxRetriesPerRequest: null on the connection.
  const connection = new Redis(redisUrl as string, { maxRetriesPerRequest: null });
  const queue = createRedisQueue(connection);
  const cache = createRedisCache(connection);
  const sender = createWebhookSender();
  const rag = makeRag(databaseUrl as string);
  const ctx: AppContext = { store, clock, ids, cache };
  const agents = makeAgents(ctx);
  // Autonomy: apply enrichment automatically, or route to human review.
  const autoApply = process.env.AGENTS_AUTO_APPLY === 'true';

  // Consume relayed events: webhook fan-out + cache invalidation + RAG embedding,
  // then run the enrich agent on newly-published entries.
  queue.process(EVENTS_TOPIC, async (payload) => {
    const ev = payload as DomainEvent;
    try {
      await dispatchEvent(ctx, { sender, cache, rag }, ev);
      if (agents && ev.type === 'entry.published') {
        const r = await agents.run('enrich', { scope: ev.scope, entryId: ev.entryId, autoApply });
        console.log(`worker: enrich ${ev.entryId} → ${r.status} (${r.decisions.join('; ')})`);
      }
      console.log(`worker: dispatched ${ev.type} ${'entryId' in ev ? ev.entryId : ''}`);
    } catch (err) {
      console.error('worker: dispatch error', ev?.type, err);
      throw err; // let BullMQ retry/dead-letter
    }
  });
  console.log(
    `worker: consuming ${EVENTS_TOPIC}${rag ? ' (+RAG)' : ''}${agents ? ` (+enrich agent, autoApply=${autoApply})` : ''}`,
  );

  // Outbox relay loop: drain pending events onto the queue.
  const tick = async () => {
    try {
      const n = await relayOutbox(ctx, queue);
      if (n > 0) console.log(`worker: relayed ${n} event(s)`);
    } catch (err) {
      console.error('worker: relay error', err);
    }
  };
  setInterval(tick, RELAY_INTERVAL_MS);
  console.log(`worker: relaying outbox every ${RELAY_INTERVAL_MS}ms`);
}

main().catch((err) => {
  console.error('worker failed to start', err);
  process.exit(1);
});

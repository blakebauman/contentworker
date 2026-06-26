import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createRedisCache, createRedisEventBus, createRedisQueue } from '@cw/adapter-redis';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import { type AgentRuntime, InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import {
  type AppContext,
  EVENTS_TOPIC,
  type RagDeps,
  dispatchEvent,
  recordAgentRun,
  relayOutbox,
  runDueScheduledActions,
} from '@cw/application';
import type { DomainEvent } from '@cw/domain';
import type { AIProvider, Clock, EmbeddingsProvider, IdGenerator } from '@cw/ports';
import { logger, startTelemetry, withSpan } from '@cw/telemetry';
import { LocalEmbeddingsProvider } from '@cw/test-kit';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { createWebhookSender } from './webhook-sender.js';

startTelemetry('cw-worker');

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
if (!redisUrl) throw new Error('REDIS_URL is required');

const RELAY_INTERVAL_MS = Number(process.env.RELAY_INTERVAL_MS ?? 1000);
const SCHEDULE_INTERVAL_MS = Number(process.env.SCHEDULE_INTERVAL_MS ?? 5000);

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
  // Dedicated connection for the Live Content API fan-out (pub/sub).
  const bus = createRedisEventBus(new Redis(redisUrl as string, { maxRetriesPerRequest: null }));
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
    const entryId = 'entryId' in ev ? ev.entryId : undefined;
    await withSpan(
      'event.dispatch',
      async () => {
        try {
          await dispatchEvent(ctx, { sender, cache, rag }, ev);
          // Fan out to Live Content API subscribers (best-effort, never blocks).
          await bus.publish(ev).catch((err) => logger.error({ err }, 'live publish error'));
          if (agents && ev.type === 'entry.published') {
            const r = await withSpan(
              'agent.enrich',
              () => agents.run('enrich', { scope: ev.scope, entryId: ev.entryId, autoApply }),
              { 'entry.id': ev.entryId },
            );
            await recordAgentRun(ctx, ev.scope, {
              workflow: 'enrich',
              entryId: ev.entryId,
              status: r.status,
              decisions: r.decisions,
              usage: r.usage,
            });
            logger.info(
              { entryId: ev.entryId, status: r.status, decisions: r.decisions, usage: r.usage },
              'enrich complete',
            );
          }
          logger.info({ type: ev.type, entryId }, 'event dispatched');
        } catch (err) {
          logger.error({ type: ev.type, entryId, err }, 'dispatch error');
          throw err; // let BullMQ retry/dead-letter
        }
      },
      { 'event.type': ev.type, ...(entryId ? { 'entry.id': entryId } : {}) },
    );
  });
  logger.info(
    { topic: EVENTS_TOPIC, rag: !!rag, enrich: !!agents, autoApply },
    'worker consuming events',
  );

  // Outbox relay loop: drain pending events onto the queue.
  const tick = async () => {
    try {
      const n = await relayOutbox(ctx, queue);
      if (n > 0) logger.info({ relayed: n }, 'outbox relayed');
    } catch (err) {
      logger.error({ err }, 'relay error');
    }
  };
  setInterval(tick, RELAY_INTERVAL_MS);
  logger.info({ intervalMs: RELAY_INTERVAL_MS }, 'worker relaying outbox');

  // Scheduled-actions loop: fire any publish/unpublish whose time has arrived.
  const scheduleTick = async () => {
    try {
      const { executed, failed } = await runDueScheduledActions(ctx);
      if (executed > 0 || failed > 0) logger.info({ executed, failed }, 'scheduled actions run');
    } catch (err) {
      logger.error({ err }, 'scheduled actions error');
    }
  };
  setInterval(scheduleTick, SCHEDULE_INTERVAL_MS);
  logger.info({ intervalMs: SCHEDULE_INTERVAL_MS }, 'worker running scheduled actions');
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});

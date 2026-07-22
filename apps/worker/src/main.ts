import { createAnthropicProvider } from '@cw/adapter-ai-anthropic';
import {
  createAzureOpenAIEmbeddings,
  createAzureOpenAIProvider,
} from '@cw/adapter-ai-azure-openai';
import { createOpenAIEmbeddings } from '@cw/adapter-embeddings-openai';
import { createHttpFunctionInvoker, createWebhookSender } from '@cw/adapter-http-effects';
import {
  createRedisCache,
  createRedisCostGuard,
  createRedisEventBus,
  createRedisQueue,
} from '@cw/adapter-redis';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import { type AgentRuntime, InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import { AGENT_TASK_QUEUE, TemporalAgentRuntime } from '@cw/agent-runtime/temporal';
import {
  type AppContext,
  EVENTS_TOPIC,
  type RagDeps,
  aiBudgetLimits,
  assertNoFakeAdapters,
  consumeEvent,
  relayOutbox,
  runDueScheduledActions,
} from '@cw/application';
import type { DomainEvent } from '@cw/domain';
import type { AIProvider, Clock, EmbeddingsProvider, IdGenerator } from '@cw/ports';
import { logger, startTelemetry, withSpan } from '@cw/telemetry';
import { LocalEmbeddingsProvider } from '@cw/test-kit';
import { Client, Connection } from '@temporalio/client';
import { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';

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
  // Explicit 'local' is informed consent to hash embeddings; an unknown value
  // would otherwise silently select them. The worker always runs persistent.
  if (provider !== 'azure-openai' && provider !== 'openai' && provider !== 'local') {
    assertNoFakeAdapters({
      persistent: true,
      allowFakeAdapters: process.env.ALLOW_FAKE_ADAPTERS,
      fakes: [
        {
          key: 'embeddings',
          detail: `unknown EMBEDDINGS_PROVIDER '${provider}' falls back to hash-based embeddings — use azure-openai or openai (any OpenAI-compatible endpoint), or local to accept explicitly`,
        },
      ],
    });
  }
  const dim = Number(process.env.EMBEDDINGS_DIM ?? 1536);
  const embeddings: EmbeddingsProvider =
    provider === 'azure-openai'
      ? createAzureOpenAIEmbeddings()
      : provider === 'openai'
        ? createOpenAIEmbeddings({ dimensions: dim })
        : new LocalEmbeddingsProvider(dim);
  const vectors = createPgVectorStore(connectionString, {
    dimensions: embeddings.dimensions,
    modelId: embeddings.modelId,
  });
  return { embeddings, vectors };
}

// Which agents run on entry.published, and with what autonomy.
const agentConfig = {
  enrich: process.env.AGENTS_ENRICH === 'true',
  moderate: process.env.AGENTS_MODERATE === 'true',
  autoApply: process.env.AGENTS_AUTO_APPLY === 'true',
};

/**
 * Builds the on-publish agent runtime when AGENTS_ENRICH and/or AGENTS_MODERATE
 * is enabled. AGENT_RUNTIME=temporal → durable execution on the Temporal cluster
 * (workflows + activities hosted by @cw/agent-worker); default is in-process
 * (non-durable).
 */
async function makeAgents(ctx: AppContext): Promise<AgentRuntime | undefined> {
  if (!agentConfig.enrich && !agentConfig.moderate) return undefined;
  if (process.env.AGENT_RUNTIME === 'temporal') {
    const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
    const connection = await Connection.connect({ address });
    const client = new Client({
      connection,
      namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    });
    logger.info({ temporal: address }, 'agents on Temporal runtime');
    return new TemporalAgentRuntime(
      client,
      process.env.TEMPORAL_TASK_QUEUE ?? AGENT_TASK_QUEUE,
      ids,
    );
  }
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
  const invoker = createHttpFunctionInvoker();
  const rag = makeRag(databaseUrl as string);
  // Meter agent AI spend per space (shared window via Redis) so on-publish
  // enrich/moderate runs count against the same budget as the HTTP API.
  const limits = aiBudgetLimits(process.env);
  const costGuard = limits ? createRedisCostGuard(connection, limits) : undefined;
  const ctx: AppContext = { store, clock, ids, cache, costGuard };
  const agents = await makeAgents(ctx);

  // Consume relayed events: webhook fan-out + cache invalidation + RAG embedding,
  // then run the configured agents (enrich, moderate) on newly-published entries.
  queue.process(EVENTS_TOPIC, async (payload) => {
    const ev = payload as DomainEvent;
    const entryId = 'entryId' in ev ? ev.entryId : undefined;
    await withSpan(
      'event.dispatch',
      async () => {
        try {
          const runs = await consumeEvent(
            ctx,
            {
              sender,
              cache,
              rag,
              invoker,
              bus,
              onLiveError: (err) => logger.error({ err }, 'live publish error'),
              agents,
              agentConfig,
            },
            ev,
          );
          for (const r of runs) {
            logger.info(
              { entryId, status: r.status, decisions: r.decisions, usage: r.usage },
              `${r.workflow} complete`,
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
    {
      topic: EVENTS_TOPIC,
      rag: !!rag,
      enrich: agentConfig.enrich,
      moderate: agentConfig.moderate,
      autoApply: agentConfig.autoApply,
    },
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

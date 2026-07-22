import { createServer } from 'node:http';
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
import { createOpenSearchIndex } from '@cw/adapter-search-opensearch';
import { createPostgresStore } from '@cw/adapter-store-postgres';
import { createPgVectorStore } from '@cw/adapter-vector-pgvector';
import { createQdrantStore } from '@cw/adapter-vector-qdrant';
import { type AgentRuntime, InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import { AGENT_TASK_QUEUE, TemporalAgentRuntime } from '@cw/agent-runtime/temporal';
import {
  type AppContext,
  EVENTS_TOPIC,
  type RagDeps,
  agentBudgetLimits,
  aiBudgetLimits,
  assertNoFakeAdapters,
  consumeEvent,
  relayOutbox,
  runDueAgentSchedules,
  runDueScheduledActions,
} from '@cw/application';
import type { DomainEvent } from '@cw/domain';
import type { AIProvider, Clock, EmbeddingsProvider, IdGenerator, SearchIndex } from '@cw/ports';
import {
  eventDispatchSeconds,
  eventsConsumedTotal,
  logger,
  metricsText,
  outboxRelayedTotal,
  relayErrorsTotal,
  relayLastTickGauge,
  scheduledActionsTotal,
  startDefaultMetrics,
  startTelemetry,
  stopTelemetry,
  webhookDeliveriesTotal,
  withSpan,
} from '@cw/telemetry';
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
// Recurring agent jobs (AGENTS_SCHEDULES=true): due-schedule poll cadence.
const AGENT_SCHEDULE_INTERVAL_MS = Number(process.env.AGENT_SCHEDULE_INTERVAL_MS ?? 60_000);
const SCHEDULES_ENABLED = process.env.AGENTS_SCHEDULES === 'true';
// Health + metrics port (K8s probes, Prometheus scrape). 9464 is the
// conventional Prometheus exporter port.
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 9464);
// Liveness fails when the relay loop hasn't completed a tick in this window —
// a hung relay (stuck connection, deadlock) then restarts the pod instead of
// silently stalling event delivery.
const RELAY_STALE_MS = Math.max(RELAY_INTERVAL_MS * 10, 60_000);

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
  const vectors =
    process.env.VECTOR_PROVIDER === 'qdrant'
      ? createQdrantStore({ dimensions: embeddings.dimensions, modelId: embeddings.modelId })
      : createPgVectorStore(connectionString, {
          dimensions: embeddings.dimensions,
          modelId: embeddings.modelId,
        });
  return { embeddings, vectors, searchIndex: makeSearchIndex() };
}

/** External lexical index (kept fresh on publish even when RAG is off). */
function makeSearchIndex(): SearchIndex | undefined {
  return process.env.SEARCH_PROVIDER === 'opensearch' ? createOpenSearchIndex() : undefined;
}

// Which agents run on entry.published, and with what autonomy.
const agentConfig = {
  enrich: process.env.AGENTS_ENRICH === 'true',
  moderate: process.env.AGENTS_MODERATE === 'true',
  autoApply: process.env.AGENTS_AUTO_APPLY === 'true',
};

/** AI provider for in-process agent activities (no dev stub on the worker). */
function makeAgentsAI(): AIProvider {
  return process.env.AI_PROVIDER === 'azure-openai'
    ? createAzureOpenAIProvider()
    : createAnthropicProvider();
}

/**
 * Builds the on-publish agent runtime when AGENTS_ENRICH and/or AGENTS_MODERATE
 * is enabled. AGENT_RUNTIME=temporal → durable execution on the Temporal cluster
 * (workflows + activities hosted by @cw/agent-worker); default is in-process
 * (non-durable).
 */
async function makeAgents(ctx: AppContext): Promise<AgentRuntime | undefined> {
  if (!agentConfig.enrich && !agentConfig.moderate && !SCHEDULES_ENABLED) return undefined;
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
  return new InProcessAgentRuntime(makeActivities({ ctx, ai: makeAgentsAI() }));
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
  // Independent of rag: lexical indexing works without embeddings. Built once
  // (the adapter memoizes its ensure-index round-trip per instance).
  const searchIndex = rag?.searchIndex ?? makeSearchIndex();
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
        const stopTimer = eventDispatchSeconds.startTimer({ type: ev.type });
        try {
          const runs = await consumeEvent(
            ctx,
            {
              sender,
              cache,
              rag,
              searchIndex,
              invoker,
              bus,
              onLiveError: (err) => logger.error({ err }, 'live publish error'),
              onWebhookDelivery: ({ delivered }) =>
                webhookDeliveriesTotal.inc({ outcome: delivered ? 'success' : 'failed' }),
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
          eventsConsumedTotal.inc({ type: ev.type, outcome: 'ok' });
          logger.info({ type: ev.type, entryId }, 'event dispatched');
        } catch (err) {
          eventsConsumedTotal.inc({ type: ev.type, outcome: 'error' });
          logger.error({ type: ev.type, entryId, err }, 'dispatch error');
          throw err; // let BullMQ retry/dead-letter
        } finally {
          stopTimer();
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

  // Outbox relay loop: drain pending events onto the queue. lastRelayTick is
  // hang detection only — it updates even on erroring ticks (finally), so a
  // Postgres outage or poison row alerts via cw_relay_errors_total instead of
  // restart-looping a worker whose consumer loops are healthy. Only a tick
  // that never RETURNS (deadlock, stuck socket) fails liveness.
  let lastRelayTick = Date.now();
  const tick = async () => {
    try {
      const n = await relayOutbox(ctx, queue);
      if (n > 0) {
        outboxRelayedTotal.inc(n);
        logger.info({ relayed: n }, 'outbox relayed');
      }
    } catch (err) {
      relayErrorsTotal.inc();
      logger.error({ err }, 'relay error');
    } finally {
      lastRelayTick = Date.now();
      relayLastTickGauge.set(lastRelayTick / 1000);
    }
  };
  const relayTimer = setInterval(tick, RELAY_INTERVAL_MS);
  logger.info({ intervalMs: RELAY_INTERVAL_MS }, 'worker relaying outbox');

  // Scheduled-actions loop: fire any publish/unpublish whose time has arrived.
  const scheduleTick = async () => {
    try {
      const { executed, failed } = await runDueScheduledActions(ctx);
      if (executed > 0) scheduledActionsTotal.inc({ outcome: 'executed' }, executed);
      if (failed > 0) scheduledActionsTotal.inc({ outcome: 'failed' }, failed);
      if (executed > 0 || failed > 0) logger.info({ executed, failed }, 'scheduled actions run');
    } catch (err) {
      logger.error({ err }, 'scheduled actions error');
    }
  };
  const scheduleTimer = setInterval(scheduleTick, SCHEDULE_INTERVAL_MS);
  logger.info({ intervalMs: SCHEDULE_INTERVAL_MS }, 'worker running scheduled actions');

  // Recurring agent jobs: run due schedules under the background agent budget
  // (AI_AGENT_* window when set — separate `cwagent` Redis keys — else the
  // standard one), so batch agent spend can never exhaust the interactive
  // window. In-process runs meter through the schedule ctx; Temporal runs
  // meter on agent-worker, whose wire applies the same AI_AGENT_* preference.
  let agentScheduleTimer: NodeJS.Timeout | undefined;
  if (SCHEDULES_ENABLED && agents) {
    const agentLimits = agentBudgetLimits(process.env);
    const scheduleCtx: AppContext = agentLimits
      ? {
          ...ctx,
          costGuard: createRedisCostGuard(connection, agentLimits, { keyPrefix: 'cwagent' }),
        }
      : ctx;
    const scheduleRunner =
      process.env.AGENT_RUNTIME === 'temporal'
        ? agents
        : new InProcessAgentRuntime(makeActivities({ ctx: scheduleCtx, ai: makeAgentsAI() }));
    const agentScheduleTick = async () => {
      try {
        const s = await runDueAgentSchedules(scheduleCtx, scheduleRunner, {
          entriesPerRun: Number(process.env.AGENT_SCHEDULE_MAX_ENTRIES ?? 25),
          maxRunTokens: Number(process.env.AGENT_SCHEDULE_MAX_RUN_TOKENS ?? 100_000),
        });
        if (s.schedules > 0) logger.info(s, 'agent schedules run');
      } catch (err) {
        logger.error({ err }, 'agent schedules error');
      }
    };
    agentScheduleTimer = setInterval(agentScheduleTick, AGENT_SCHEDULE_INTERVAL_MS);
    logger.info({ intervalMs: AGENT_SCHEDULE_INTERVAL_MS }, 'worker running agent schedules');
  }

  // Health (K8s liveness/readiness) + Prometheus metrics.
  startDefaultMetrics('cw-worker');
  const health = createServer(async (req, res) => {
    if (req.url === '/healthz') {
      const stale = Date.now() - lastRelayTick > RELAY_STALE_MS;
      res.writeHead(stale ? 500 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: stale ? 'relay stalled' : 'ok' }));
      return;
    }
    // Readiness is unconditional: it only gates the metrics Service endpoints,
    // and dropping the scrape target during an incident would hide the data.
    if (req.url === '/readyz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(await metricsText());
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(HEALTH_PORT, () => logger.info({ port: HEALTH_PORT }, 'worker health listening'));

  // Graceful shutdown: stop the loops, drain the BullMQ consumer (in-flight
  // jobs finish; the outbox/queue redeliver anything else), then close
  // connections so pod rotation never hard-kills mid-dispatch.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'worker shutting down');
    clearInterval(relayTimer);
    clearInterval(scheduleTimer);
    if (agentScheduleTimer) clearInterval(agentScheduleTimer);
    health.close();
    try {
      await queue.close();
      await bus.close();
      connection.disconnect();
      await store.close();
      await stopTelemetry();
    } catch (err) {
      logger.error({ err }, 'shutdown cleanup error');
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  process.exit(1);
});

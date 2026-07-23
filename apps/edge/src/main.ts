import { createHttpFunctionInvoker, createWebhookSender } from '@cw/adapter-http-effects';
import { InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import { createApp } from '@cw/api/app';
import { type AuthDeps, createApiHasher } from '@cw/api/auth';
import { mountsRole } from '@cw/api/config';
import { validateApiSecrets } from '@cw/api/secure-secrets';
import {
  type ConsumeDeps,
  consumeEvent,
  createHasher,
  drainOutbox,
  pruneEventHistory,
  resumeStalledBulkJobs,
  runDueAgentSchedules,
  runDueScheduledActions,
  runPublishAgents,
} from '@cw/application';
import type { McpDeps } from '@cw/mcp-server/wire';
import { seedConfigFrom, seedDev } from '@cw/seed';
import { Hono } from 'hono';
import { sendReviewDecision } from './agents/runtime.js';
import { AgentWorkflow } from './agents/workflow.js';
import { CostGuardDO, doAgentCostGuardFromEnv } from './do/cost-guard.js';
import { LiveHubDO, createDoEventBus } from './do/live-hub.js';
import { RateLimiterDO, createDoRateLimiter } from './do/rate-limiter.js';
import type { EdgeEnv } from './env.js';
import { mcpRoutes } from './mcp.js';
import { type AgentJobMessage, isAgentJob, isDomainEvent } from './messages.js';
import { makeMetrics } from './metrics.js';
import { liveRoutes } from './routes/live.js';
import { type EdgeWired, agentConfigFromEnv, makeAgents, wireEdge } from './wire.js';

// Worker-entrypoint classes must be exported from the deployed script.
export { AgentWorkflow, CostGuardDO, LiveHubDO, RateLimiterDO };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Idempotent dev bootstrap runs once per isolate (SEED_DEV + real database). */
let devSeeded = false;

function buildApp(wired: EdgeWired, env: EdgeEnv): Hono {
  const app = new Hono();
  const mountManagement = mountsRole(wired.config, 'management');
  // Distributed failed-auth limiter: one DO per client IP, global across
  // isolates (the in-process default only sees its own isolate's failures).
  const rateLimiter = env.AUTH_LIMITER ? createDoRateLimiter(env.AUTH_LIMITER) : undefined;

  if (env.LIVE_HUB) {
    // Pre-mounted (first match wins): the DO-served Live Content API replaces
    // the stock in-process SSE route, with the identical auth chain.
    const authDeps: AuthDeps = {
      ctx: wired.ctx,
      hasher: createApiHasher(wired.config.tokenPepper),
      adminToken: wired.config.adminToken,
      sessionSecret: wired.config.sessionSecret,
      rag: wired.rag,
      blob: wired.blob,
      ai: wired.ai,
      bus: wired.bus,
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      rateLimiter,
    };
    app.route('/', liveRoutes(authDeps, env.LIVE_HUB));
  }

  // MCP mounts only with an explicit MCP_TOKEN on persistent (production)
  // deployments — the dev fallback token would otherwise grant wildcard-space
  // admin on a public URL. Demo mode (in-memory) keeps the dev token.
  const mcpToken = env.MCP_TOKEN ?? (wired.persistent ? undefined : 'dev-mcp-token');
  if (mountManagement && mcpToken) {
    const mcpDeps: McpDeps = {
      ctx: wired.ctx,
      ai: wired.ai,
      rag: wired.rag,
      // On-demand agent actions are synchronous request/response, so they run
      // in-process (same policy as apps/api + apps/mcp-server); the durable
      // Workflows runtime serves the queue consumer's on-publish runs.
      agents: new InProcessAgentRuntime(makeActivities({ ctx: wired.ctx, ai: wired.ai })),
      hasher: createHasher(env.TOKEN_PEPPER),
      adminToken: mcpToken,
      moderateBeforePublish: wired.config.moderateBeforePublish,
      signalReview: env.AGENT_WF
        ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
        : undefined,
    };
    app.route('/', mcpRoutes(mcpDeps));
  }

  app.route(
    '/',
    createApp(
      wired.ctx,
      wired.config,
      wired.rag,
      wired.blob,
      wired.ai,
      wired.bus,
      rateLimiter,
      // Review decisions reach the durable watcher as Workflow events.
      env.AGENT_WF
        ? (review, decision) => sendReviewDecision(env.AGENT_WF as Workflow, review.id, decision)
        : undefined,
    ),
  );
  return app;
}

/**
 * cw-events consumer body. When AGENTS_QUEUE is bound, entry.published events
 * enqueue an agent job there (before ack, so at-least-once holds) instead of
 * awaiting workflows inline — a batch of 25 published entries then costs 25
 * cheap sends, not up to 25×2 polled Workflow runs in one invocation.
 */
async function consumeEvents(batch: MessageBatch, env: EdgeEnv, wired: EdgeWired): Promise<void> {
  const metrics = makeMetrics(env.METRICS);
  const agentConfig = agentConfigFromEnv(env);
  const agentsConfigured = agentConfig.enrich || agentConfig.moderate;
  const forwardAgents = Boolean(env.AGENTS_QUEUE) && agentsConfigured;
  const deps: ConsumeDeps = {
    // One coalescing set per batch: a batch of same-type publishes writes each
    // cache tag once instead of once per message (KV rate-limits per key).
    invalidatedTags: new Set<string>(),
    sender: createWebhookSender(),
    invoker: createHttpFunctionInvoker(),
    cache: wired.cache,
    // Parity with the Node worker: RAG indexing only when embeddings are
    // explicitly configured (EMBEDDINGS_PROVIDER), never with the dev fallback.
    rag: env.EMBEDDINGS_PROVIDER ? wired.rag : undefined,
    // Independent of rag: lexical indexing works without embeddings.
    searchIndex: wired.rag.searchIndex,
    bus: env.LIVE_HUB ? createDoEventBus(env.LIVE_HUB) : undefined,
    onLiveError: (err) => console.error('live publish error', err),
    // Inline agents only when no cw-agents queue is bound (dev/demo parity).
    agents: forwardAgents ? undefined : makeAgents(env, wired.ctx, wired.ai),
    agentConfig: forwardAgents ? undefined : agentConfig,
  };
  for (const msg of batch.messages) {
    // Validate the message shape before treating it as a DomainEvent. A
    // malformed/poison message is acked (dropped) rather than retried forever.
    if (!isDomainEvent(msg.body)) {
      console.error('dropping malformed queue message', { id: msg.id });
      metrics.count('cw_events_consumed_total', 1, { type: 'malformed', outcome: 'dropped' });
      msg.ack();
      continue;
    }
    try {
      const runs = await consumeEvent(wired.ctx, deps, msg.body);
      for (const r of runs) {
        console.log(JSON.stringify({ msg: `${r.workflow} complete`, ...r }));
      }
      if (forwardAgents && msg.body.type === 'entry.published' && env.AGENTS_QUEUE) {
        const job: AgentJobMessage = {
          kind: 'agent.publish_run',
          scope: msg.body.scope,
          entryId: msg.body.entryId,
        };
        await env.AGENTS_QUEUE.send(job);
      }
      metrics.count('cw_events_consumed_total', 1, { type: msg.body.type, outcome: 'ok' });
      msg.ack();
    } catch (err) {
      console.error('event dispatch failed; retrying', err);
      metrics.count('cw_events_consumed_total', 1, { type: msg.body.type, outcome: 'error' });
      msg.retry();
    }
  }
}

/**
 * cw-agents consumer body: runs the on-publish agents for one entry per
 * message. runPublishAgents owns the post-run behavior (AgentRun records,
 * moderation retraction), so those survive the move off the events consumer.
 */
async function consumeAgentJobs(
  batch: MessageBatch,
  env: EdgeEnv,
  wired: EdgeWired,
): Promise<void> {
  const metrics = makeMetrics(env.METRICS);
  const agentConfig = agentConfigFromEnv(env);
  const agents = makeAgents(env, wired.ctx, wired.ai);
  for (const msg of batch.messages) {
    if (!isAgentJob(msg.body)) {
      console.error('dropping malformed agent job', { id: msg.id });
      metrics.count('cw_agent_jobs_total', 1, { outcome: 'dropped' });
      msg.ack();
      continue;
    }
    if (!agents) {
      // Agents were disabled after the job was enqueued — drop, don't retry.
      metrics.count('cw_agent_jobs_total', 1, { outcome: 'disabled' });
      msg.ack();
      continue;
    }
    try {
      const runs = await runPublishAgents(
        wired.ctx,
        agents,
        msg.body.scope,
        msg.body.entryId,
        agentConfig,
      );
      for (const r of runs) {
        console.log(JSON.stringify({ msg: `${r.workflow} complete`, ...r }));
      }
      metrics.count('cw_agent_jobs_total', 1, { outcome: 'ok' });
      msg.ack();
    } catch (err) {
      console.error('agent job failed; retrying', err);
      metrics.count('cw_agent_jobs_total', 1, { outcome: 'error' });
      msg.retry();
    }
  }
}

export default {
  /**
   * HTTP surface: management/delivery/preview APIs + MCP + the DO live route.
   * Wiring is per request (postgres.js sockets cannot cross Worker requests;
   * Hyperdrive keeps the connect cheap). After a mutating request, an outbox
   * relay nudge runs in waitUntil — sub-second event latency without the Node
   * worker's 1s polling loop; the cron sweeper covers crashes.
   */
  async fetch(req: Request, env: EdgeEnv, exec: ExecutionContext): Promise<Response> {
    const wired = wireEdge(env);
    try {
      validateApiSecrets(wired.config, env as unknown as NodeJS.ProcessEnv);
      if (wired.config.seedDev && wired.persistent && !devSeeded) {
        await seedDev(wired.ctx, seedConfigFrom(wired.config), { blob: wired.blob });
        devSeeded = true;
      }
      const app = buildApp(wired, env);
      const res = await app.fetch(req, env, exec);
      exec.waitUntil(
        (async () => {
          const metrics = makeMetrics(env.METRICS);
          try {
            if (wired.queue && MUTATING.has(req.method)) {
              // Loop-until-drained: a bulk mutation can append far more rows
              // than one relay batch; its own nudge should clear them rather
              // than leaving the overflow to the cron sweeper.
              const relayed = await drainOutbox(wired.ctx, wired.queue, {
                routeTopic: wired.routeTopic,
              });
              if (relayed > 0) {
                metrics.count('cw_outbox_relayed_total', relayed, { trigger: 'nudge' });
              }
            }
          } catch (err) {
            console.error('outbox relay nudge failed', err);
            metrics.count('cw_relay_errors_total', 1, { trigger: 'nudge' });
          } finally {
            await wired.close();
          }
        })(),
      );
      return res;
    } catch (err) {
      exec.waitUntil(wired.close());
      throw err;
    }
  },

  /**
   * Queue consumers, routed by queue name:
   * - cw-events: the same consumeEvent body the Node worker runs — webhooks,
   *   cache invalidation, RAG indexing (one bounded slice per reindex message),
   *   functions, live fan-out. On-publish agent runs are forwarded to cw-agents
   *   when that queue is bound, else run inline (dev parity).
   * - cw-agents: one agent job per invocation (batch size 1) — each job can
   *   await durable Workflow runs for minutes without starving event delivery.
   * - cw-events-dlq: dead letters are logged loudly and acked, never silent.
   * Per-message ack/retry so one poison message doesn't recycle a batch.
   */
  async queue(batch: MessageBatch, env: EdgeEnv, _exec: ExecutionContext): Promise<void> {
    if (batch.queue === 'cw-events-dlq') {
      const metrics = makeMetrics(env.METRICS);
      for (const msg of batch.messages) {
        console.error(
          JSON.stringify({
            msg: 'dead-lettered message dropped after max retries',
            id: msg.id,
            body: msg.body,
          }),
        );
        metrics.count('cw_dead_letters_total');
        msg.ack();
      }
      return;
    }

    const wired = wireEdge(env);
    try {
      if (batch.queue === 'cw-agents') {
        await consumeAgentJobs(batch, env, wired);
      } else {
        await consumeEvents(batch, env, wired);
      }
      // Events appended during consumption — reindex continuation slices,
      // moderation retractions — relay now instead of waiting for the cron.
      if (wired.queue) {
        const metrics = makeMetrics(env.METRICS);
        await drainOutbox(wired.ctx, wired.queue, { routeTopic: wired.routeTopic }).then(
          (relayed) => {
            if (relayed > 0) {
              metrics.count('cw_outbox_relayed_total', relayed, { trigger: 'post-batch' });
            }
          },
          (err) => {
            console.error('post-batch outbox relay failed', err);
            metrics.count('cw_relay_errors_total', 1, { trigger: 'post-batch' });
          },
        );
      }
    } finally {
      await wired.close();
    }
  },

  /**
   * Cron sweeper (every minute): drains any outbox rows the post-commit nudge
   * missed (crash/eviction) and fires due scheduled publish/unpublish actions.
   */
  async scheduled(ctrl: ScheduledController, env: EdgeEnv, _exec: ExecutionContext) {
    const wired = wireEdge(env);
    const metrics = makeMetrics(env.METRICS);
    try {
      // Retention sweep on the top-of-hour tick only (the cron fires every
      // minute): trims relayed outbox rows + old webhook delivery records.
      if (wired.persistent && new Date(ctrl.scheduledTime).getUTCMinutes() === 0) {
        try {
          const pruned = await pruneEventHistory(wired.ctx, {
            ...(env.EVENT_RETENTION_HOURS
              ? { retentionHours: Number(env.EVENT_RETENTION_HOURS) }
              : {}),
          });
          if (pruned.outboxDeleted > 0 || pruned.webhookDeliveriesDeleted > 0) {
            console.log(JSON.stringify({ msg: 'event history pruned', ...pruned }));
            metrics.count('cw_events_pruned_total', pruned.outboxDeleted, { table: 'outbox' });
            metrics.count('cw_events_pruned_total', pruned.webhookDeliveriesDeleted, {
              table: 'webhook_deliveries',
            });
          }
        } catch (err) {
          console.error('event history prune failed', err);
        }
      }
      // Actions first: their outbox events are then picked up by the relay
      // sweep below instead of waiting a full cron interval.
      const { executed, failed } = await runDueScheduledActions(wired.ctx);
      if (executed > 0)
        metrics.count('cw_scheduled_actions_total', executed, { outcome: 'executed' });
      if (failed > 0) metrics.count('cw_scheduled_actions_total', failed, { outcome: 'failed' });
      if (executed > 0 || failed > 0) {
        console.log(JSON.stringify({ msg: 'scheduled actions run', executed, failed }));
      }
      // A relay error must not abort the tick (agent schedules still run) —
      // same containment as the Node worker's relay loop.
      if (wired.queue) {
        try {
          const total = await drainOutbox(wired.ctx, wired.queue, {
            maxIterations: 20,
            routeTopic: wired.routeTopic,
          });
          if (total > 0) metrics.count('cw_outbox_relayed_total', total, { trigger: 'cron' });
        } catch (err) {
          console.error('cron outbox relay failed', err);
          metrics.count('cw_relay_errors_total', 1, { trigger: 'cron' });
        }
      }
      // Bulk-job crash recovery: re-nudge chunks whose claim went stale or
      // whose chunk_due event was lost (normally returns 0 — one cheap
      // indexed query). The re-appended events relay on the next tick's
      // drain (or the following nudge).
      if (wired.persistent) {
        try {
          const resumed = await resumeStalledBulkJobs(wired.ctx);
          if (resumed > 0) {
            console.log(JSON.stringify({ msg: 'stalled bulk chunks re-nudged', resumed }));
            metrics.count('cw_bulk_chunks_resumed_total', resumed);
          }
        } catch (err) {
          console.error('bulk stall sweep failed', err);
        }
      }
      // Recurring agent jobs: due schedules run here on the cron tick, metered
      // through a separate background counter window (the `agent:` DO prefix,
      // AI_AGENT_* ceilings when set) so batch spend can't exhaust the
      // interactive budget.
      if (env.AGENTS_SCHEDULES === 'true') {
        const bgGuard = doAgentCostGuardFromEnv(env);
        const scheduleCtx = { ...wired.ctx, costGuard: bgGuard ?? wired.ctx.costGuard };
        const agents = makeAgents(env, scheduleCtx, wired.ai);
        if (agents) {
          const s = await runDueAgentSchedules(scheduleCtx, agents, {
            entriesPerRun: Number(env.AGENT_SCHEDULE_MAX_ENTRIES ?? 25),
            maxRunTokens: Number(env.AGENT_SCHEDULE_MAX_RUN_TOKENS ?? 100_000),
          });
          if (s.schedules > 0) console.log(JSON.stringify({ msg: 'agent schedules run', ...s }));
        }
      }
    } finally {
      await wired.close();
    }
  },
} satisfies ExportedHandler<EdgeEnv>;

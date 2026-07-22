import { createHttpFunctionInvoker, createWebhookSender } from '@cw/adapter-http-effects';
import { InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import { createApp } from '@cw/api/app';
import { type AuthDeps, createApiHasher } from '@cw/api/auth';
import { validateApiSecrets } from '@cw/api/secure-secrets';
import { seedDev } from '@cw/api/seed';
import {
  type ConsumeDeps,
  consumeEvent,
  createHasher,
  relayOutbox,
  runDueScheduledActions,
} from '@cw/application';
import type { DomainEvent } from '@cw/domain';
import type { McpDeps } from '@cw/mcp-server/wire';
import { Hono } from 'hono';
import { AgentWorkflow } from './agents/workflow.js';
import { LiveHubDO, createDoEventBus } from './do/live-hub.js';
import { RateLimiterDO, createDoRateLimiter } from './do/rate-limiter.js';
import type { EdgeEnv } from './env.js';
import { mcpRoutes } from './mcp.js';
import { liveRoutes } from './routes/live.js';
import { type EdgeWired, agentConfigFromEnv, makeAgents, wireEdge } from './wire.js';

// Worker-entrypoint classes must be exported from the deployed script.
export { AgentWorkflow, LiveHubDO, RateLimiterDO };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Minimal runtime shape check for a queued DomainEvent (defensive, not exhaustive). */
function isDomainEvent(body: unknown): body is DomainEvent {
  if (typeof body !== 'object' || body === null) return false;
  const e = body as Record<string, unknown>;
  const scope = e.scope as Record<string, unknown> | undefined;
  return (
    typeof e.id === 'string' &&
    typeof e.type === 'string' &&
    typeof e.occurredAt === 'string' &&
    typeof scope?.spaceId === 'string' &&
    typeof scope?.environmentId === 'string'
  );
}

/** Idempotent dev bootstrap runs once per isolate (SEED_DEV + real database). */
let devSeeded = false;

function buildApp(wired: EdgeWired, env: EdgeEnv): Hono {
  const app = new Hono();
  const mountManagement = wired.config.role === 'all' || wired.config.role === 'management';
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
    };
    app.route('/', mcpRoutes(mcpDeps));
  }

  app.route(
    '/',
    createApp(wired.ctx, wired.config, wired.rag, wired.blob, wired.ai, wired.bus, rateLimiter),
  );
  return app;
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
        await seedDev(wired.ctx, wired.config);
        devSeeded = true;
      }
      const app = buildApp(wired, env);
      const res = await app.fetch(req, env, exec);
      exec.waitUntil(
        (async () => {
          try {
            if (wired.queue && MUTATING.has(req.method)) {
              await relayOutbox(wired.ctx, wired.queue);
            }
          } catch (err) {
            console.error('outbox relay nudge failed', err);
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
   * cw-events consumer: the same consumeEvent body the Node worker runs —
   * webhooks, cache invalidation, RAG indexing, functions, live fan-out,
   * on-publish agents. Per-message ack/retry so one poison event doesn't
   * recycle the whole batch; retries/DLQ are configured on the queue binding.
   */
  async queue(batch: MessageBatch, env: EdgeEnv, _exec: ExecutionContext): Promise<void> {
    const wired = wireEdge(env);
    const deps: ConsumeDeps = {
      sender: createWebhookSender(),
      invoker: createHttpFunctionInvoker(),
      cache: wired.cache,
      // Parity with the Node worker: RAG indexing only when embeddings are
      // explicitly configured (EMBEDDINGS_PROVIDER), never with the dev fallback.
      rag: env.EMBEDDINGS_PROVIDER ? wired.rag : undefined,
      bus: env.LIVE_HUB ? createDoEventBus(env.LIVE_HUB) : undefined,
      onLiveError: (err) => console.error('live publish error', err),
      agents: makeAgents(env, wired.ctx, wired.ai),
      agentConfig: agentConfigFromEnv(env),
    };
    try {
      for (const msg of batch.messages) {
        // Validate the message shape before treating it as a DomainEvent. A
        // malformed/poison message is acked (dropped) rather than retried forever.
        if (!isDomainEvent(msg.body)) {
          console.error('dropping malformed queue message', { id: msg.id });
          msg.ack();
          continue;
        }
        try {
          const runs = await consumeEvent(wired.ctx, deps, msg.body);
          for (const r of runs) {
            console.log(JSON.stringify({ msg: `${r.workflow} complete`, ...r }));
          }
          msg.ack();
        } catch (err) {
          console.error('event dispatch failed; retrying', err);
          msg.retry();
        }
      }
    } finally {
      await wired.close();
    }
  },

  /**
   * Cron sweeper (every minute): drains any outbox rows the post-commit nudge
   * missed (crash/eviction) and fires due scheduled publish/unpublish actions.
   */
  async scheduled(_ctrl: ScheduledController, env: EdgeEnv, _exec: ExecutionContext) {
    const wired = wireEdge(env);
    try {
      // Actions first: their outbox events are then picked up by the relay
      // sweep below instead of waiting a full cron interval.
      const { executed, failed } = await runDueScheduledActions(wired.ctx);
      if (executed > 0 || failed > 0) {
        console.log(JSON.stringify({ msg: 'scheduled actions run', executed, failed }));
      }
      if (wired.queue) {
        for (let i = 0; i < 10; i++) {
          const relayed = await relayOutbox(wired.ctx, wired.queue);
          if (relayed === 0) break;
        }
      }
    } finally {
      await wired.close();
    }
  },
} satisfies ExportedHandler<EdgeEnv>;

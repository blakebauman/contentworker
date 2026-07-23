import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config';

// Runs the suite inside workerd so the Durable Objects execute for real
// (storage, alarms, RPC). The fixture worker exports only the DO classes —
// not src/main.ts — to keep the test module graph free of the Postgres/queue
// adapters. The compatibility date is the newest the pool's bundled workerd
// supports (older than production's; the DOs use no newer runtime features).
export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        main: './test/fixtures/worker.ts',
        miniflare: {
          compatibilityDate: '2025-03-10',
          compatibilityFlags: ['nodejs_compat'],
          durableObjects: {
            LIVE_HUB: 'LiveHubDO',
            AUTH_LIMITER: 'RateLimiterDO',
            AI_BUDGET: 'CostGuardDO',
          },
          bindings: {
            AUTH_RATE_LIMIT_MAX: '3',
            AUTH_RATE_LIMIT_WINDOW_MS: '300',
            AI_MAX_REQUESTS_PER_WINDOW: '2',
            AI_MAX_TOKENS_PER_WINDOW: '100',
            // Wide enough that a test's sequential RPCs can't straddle a
            // window roll on a slow runner; only the lapse test sleeps it out.
            AI_BUDGET_WINDOW_SECONDS: '2',
            // Background (`agent:`) windows enforce the stricter agent ceiling.
            AI_AGENT_MAX_REQUESTS_PER_WINDOW: '1',
          },
        },
      },
    },
  },
});

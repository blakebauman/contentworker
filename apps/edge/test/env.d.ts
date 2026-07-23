import type { CostGuardDO } from '../src/do/cost-guard.js';
import type { LiveHubDO } from '../src/do/live-hub.js';
import type { RateLimiterDO } from '../src/do/rate-limiter.js';

declare module 'cloudflare:test' {
  // Bindings provided by vitest.config.ts (miniflare section), typed as
  // required — unlike EdgeEnv, where every binding is optional.
  interface ProvidedEnv {
    readonly LIVE_HUB: DurableObjectNamespace<LiveHubDO>;
    readonly AUTH_LIMITER: DurableObjectNamespace<RateLimiterDO>;
    readonly AI_BUDGET: DurableObjectNamespace<CostGuardDO>;
  }
}

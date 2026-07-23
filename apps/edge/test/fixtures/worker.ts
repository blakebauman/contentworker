// Test-only worker entry: exports the Durable Object classes under test with a
// minimal fetch handler, so the vitest-pool-workers runtime can bind them
// without pulling src/main.ts's full adapter graph into the test bundle.
export { CostGuardDO } from '../../src/do/cost-guard.js';
export { LiveHubDO } from '../../src/do/live-hub.js';
export { RateLimiterDO } from '../../src/do/rate-limiter.js';

export default {
  fetch(): Response {
    return new Response('test fixture');
  },
};

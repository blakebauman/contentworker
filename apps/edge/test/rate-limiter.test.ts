import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { createDoRateLimiter } from '../src/do/rate-limiter.js';

// vitest.config.ts binds AUTH_RATE_LIMIT_MAX=3, AUTH_RATE_LIMIT_WINDOW_MS=300.
const MAX = 3;
const WINDOW_MS = 300;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('RateLimiterDO via createDoRateLimiter', () => {
  it('blocks a key once it reaches the failure budget', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    const key = 'ip-blocks';
    expect(await limiter.isBlocked(key)).toBe(false);
    expect(await limiter.recordFailure(key)).toBe(false);
    expect(await limiter.recordFailure(key)).toBe(false);
    // The Nth failure trips the budget and reports it to the caller.
    expect(await limiter.recordFailure(key)).toBe(true);
    expect(await limiter.isBlocked(key)).toBe(true);
  });

  it('keeps budgets independent per key', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    for (let i = 0; i < MAX; i++) await limiter.recordFailure('ip-noisy');
    expect(await limiter.isBlocked('ip-noisy')).toBe(true);
    expect(await limiter.isBlocked('ip-quiet')).toBe(false);
  });

  it('unblocks after the window lapses', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    const key = 'ip-lapses';
    for (let i = 0; i < MAX; i++) await limiter.recordFailure(key);
    expect(await limiter.isBlocked(key)).toBe(true);
    await sleep(WINDOW_MS + 100);
    expect(await limiter.isBlocked(key)).toBe(false);
  });

  it('clear resets the budget immediately (successful auth path)', async () => {
    const limiter = createDoRateLimiter(env.AUTH_LIMITER);
    const key = 'ip-clears';
    for (let i = 0; i < MAX; i++) await limiter.recordFailure(key);
    expect(await limiter.isBlocked(key)).toBe(true);
    await limiter.clear(key);
    expect(await limiter.isBlocked(key)).toBe(false);
  });
});

import type { DomainEvent } from '@cw/domain';
import { Redis } from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createRedisCache, createRedisEventBus, createRedisQueue } from '../src/index.js';

// Gated on TEST_REDIS_URL so the normal suite (no Redis) skips it.
const url = process.env.TEST_REDIS_URL;

// Unique per-run prefix so parallel/re-runs never collide on shared keys.
const run = `cwtest:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;

const waitFor = async (predicate: () => boolean, timeoutMs = 5000) => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
};

describe.skipIf(!url)('Redis adapters against a real Redis (contract)', () => {
  // BullMQ requires maxRetriesPerRequest: null on the connection.
  const connection = new Redis(url as string, { maxRetriesPerRequest: null });
  const closers: Array<() => Promise<unknown>> = [() => connection.quit()];

  afterAll(async () => {
    for (const close of closers.reverse()) await close().catch(() => {});
  });

  it('cache: set → get round-trips, and invalidating a tag deletes its members', async () => {
    const cache = createRedisCache(connection, 60);

    await cache.set(`${run}:a`, 'value-a', { tags: ['space-1'] });
    await cache.set(`${run}:b`, 'value-b', { tags: ['space-1', 'other'] });
    await cache.set(`${run}:c`, 'value-c', { tags: ['other'] });

    expect(await cache.get(`${run}:a`)).toBe('value-a');

    await cache.invalidateTag('space-1');
    expect(await cache.get(`${run}:a`)).toBeNull();
    expect(await cache.get(`${run}:b`)).toBeNull();
    // Keys under untouched tags survive.
    expect(await cache.get(`${run}:c`)).toBe('value-c');
  });

  it('queue: enqueued payload is delivered to the topic worker, dedupeKey collapses duplicates', async () => {
    const queue = createRedisQueue(connection);
    closers.push(() => queue.close());

    // BullMQ forbids ':' in queue names, so derive a colon-free topic.
    const topic = `${run.replaceAll(':', '-')}-topic`;
    const received: unknown[] = [];
    const sub = queue.process(topic, async (payload) => {
      received.push(payload);
    });
    closers.push(() => sub.close());

    await queue.enqueue(topic, { hello: 'world' });
    await queue.enqueue(topic, { n: 1 }, { dedupeKey: `${run}-dupe` });
    await queue.enqueue(topic, { n: 2 }, { dedupeKey: `${run}-dupe` });

    await waitFor(() => received.length >= 2);
    // A brief grace period to catch a wrongly-delivered duplicate.
    await new Promise((r) => setTimeout(r, 250));
    expect(received).toHaveLength(2);
    expect(received).toContainEqual({ hello: 'world' });
    expect(received).toContainEqual({ n: 1 });
  });

  it('event bus: publish fans out to matching subscribers only', async () => {
    const bus = createRedisEventBus(connection);
    closers.push(() => bus.close());

    const matched: DomainEvent[] = [];
    const unmatched: DomainEvent[] = [];
    const subA = bus.subscribe('entry.*', async (e) => {
      matched.push(e);
    });
    const subB = bus.subscribe('asset.*', async (e) => {
      unmatched.push(e);
    });
    closers.push(
      () => subA.close(),
      () => subB.close(),
    );

    // ioredis subscribes asynchronously; give the SUBSCRIBE a moment to land.
    await new Promise((r) => setTimeout(r, 250));

    const event: DomainEvent = {
      id: `${run}-event`,
      type: 'entry.published',
      occurredAt: new Date(0).toISOString(),
      scope: { spaceId: 'space-1', environmentId: 'main' },
      entryId: 'entry-1',
      contentTypeApiId: 'article',
    };
    await bus.publish(event);

    await waitFor(() => matched.length >= 1);
    expect(matched[0]).toMatchObject({ id: `${run}-event`, type: 'entry.published' });
    expect(unmatched).toHaveLength(0);
  });
});

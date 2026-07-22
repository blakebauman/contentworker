import {
  FixedClock,
  InMemoryCache,
  InMemoryContentStore,
  InMemoryQueue,
  RecordingWebhookSender,
  SequenceIdGenerator,
} from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  EVENTS_TOPIC,
  cacheTag,
  createContentType,
  createEntry,
  createSpace,
  createWebhook,
  dispatchEvent,
  getPublishedEntry,
  publishEntry,
  relayOutbox,
} from '../src/index.js';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const cache = new InMemoryCache();
  const queue = new InMemoryQueue();
  const sender = new RecordingWebhookSender();
  const ctx: AppContext = {
    store,
    clock: new FixedClock(),
    ids: new SequenceIdGenerator('e'),
    cache,
  };
  // The worker's consumer: dispatch each relayed event.
  queue.process(EVENTS_TOPIC, (payload) => dispatchEvent(ctx, { sender, cache }, payload as never));
  return { ctx, store, cache, queue, sender };
}

async function seedAndPublish(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'article',
    name: 'Article',
    displayField: 'title',
    fields: [
      {
        apiId: 'title',
        name: 'Title',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
  const entry = await createEntry(ctx, scope, {
    contentTypeApiId: 'article',
    fields: { title: { 'en-US': 'V1' } },
  });
  await publishEntry(ctx, scope, entry.entry.id);
  return entry.entry.id;
}

describe('P4: outbox relay, webhook fan-out, cache invalidation', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it('relays outbox events and delivers them to subscribed webhooks', async () => {
    await createWebhook(h.ctx, scope, {
      url: 'https://hook.example/cw',
      topics: ['entry.published'],
      secret: 's3cr3t',
    });
    const id = await seedAndPublish(h.ctx);

    // Events sit in the outbox until relayed.
    expect(h.queue.depth).toBe(0);
    const relayed = await relayOutbox(h.ctx, h.queue);
    expect(relayed).toBeGreaterThanOrEqual(1);

    await h.queue.drain();

    // The webhook received the entry.published event (and not content_type.published).
    const events = h.sender.sent.map((s) => s.event.type);
    expect(events).toContain('entry.published');
    expect(events).not.toContain('content_type.published');
    expect(h.sender.sent[0]?.webhook.url).toBe('https://hook.example/cw');
    expect(h.store.webhookDeliveries.some((d) => d.status === 'success')).toBe(true);
    expect(id).toBeTruthy();
  });

  it('does not relay the same event twice', async () => {
    await seedAndPublish(h.ctx);
    const first = await relayOutbox(h.ctx, h.queue);
    const second = await relayOutbox(h.ctx, h.queue);
    expect(first).toBeGreaterThan(0);
    expect(second).toBe(0);
  });

  it('serves a cached delivery render, then invalidates it on republish', async () => {
    const id = await seedAndPublish(h.ctx);

    // Prime the cache.
    const first = await getPublishedEntry(h.ctx, scope, id, { locale: 'en-US' });
    expect(first.fields.title).toBe('V1');
    expect(h.cache.size).toBe(1);

    // An entry.published event for this entry should evict its cached render.
    await dispatchEvent(
      h.ctx,
      { sender: h.sender, cache: h.cache },
      {
        id: 'evt-x',
        type: 'entry.published',
        scope,
        occurredAt: '2026-01-01T00:00:00.000Z',
        entryId: id,
        contentTypeApiId: 'article',
        version: 2,
        fields: {},
      },
    );
    expect(h.cache.size).toBe(0);
  });

  it('invalidates transitively embedding entries, not just direct referrers', async () => {
    const id = await seedAndPublish(h.ctx);
    // Reference chain: a embeds b, b embeds the published entry (id).
    await h.ctx.store.references.replaceForEntry(scope, 'entry-b', [
      { fromEntryId: 'entry-b', fromField: 'embed', toId: id },
    ]);
    await h.ctx.store.references.replaceForEntry(scope, 'entry-a', [
      { fromEntryId: 'entry-a', fromField: 'embed', toId: 'entry-b' },
    ]);
    // Prime cached renders for all three under their entry tags.
    for (const e of [id, 'entry-a', 'entry-b']) {
      await h.cache.set(`render:${e}`, 'cached', { tags: [cacheTag(scope, e)] });
    }
    // Unrelated entry stays cached.
    await h.cache.set('render:other', 'cached', { tags: [cacheTag(scope, 'other')] });

    await dispatchEvent(
      h.ctx,
      { sender: h.sender, cache: h.cache },
      {
        id: 'evt-transitive',
        type: 'entry.published',
        scope,
        occurredAt: '2026-01-01T00:00:00.000Z',
        entryId: id,
        contentTypeApiId: 'article',
        version: 2,
        fields: {},
      },
    );

    expect(await h.cache.get(`render:${id}`)).toBeNull();
    expect(await h.cache.get('render:entry-b')).toBeNull(); // direct referrer
    expect(await h.cache.get('render:entry-a')).toBeNull(); // transitive (2 hops)
    expect(await h.cache.get('render:other')).toBe('cached');
  });

  it('relays with the event id as the dedupe key', async () => {
    await seedAndPublish(h.ctx);
    const seen: (string | undefined)[] = [];
    const recordingQueue = {
      enqueue: async (_topic: string, payload: unknown, opts?: { dedupeKey?: string }) => {
        seen.push(opts?.dedupeKey);
        void payload;
      },
      process: () => ({ close: async () => {} }),
    };
    const relayed = await relayOutbox(h.ctx, recordingQueue);
    expect(relayed).toBeGreaterThan(0);
    expect(seen.length).toBe(relayed);
    for (const key of seen) expect(key).toBeTruthy();
  });
});

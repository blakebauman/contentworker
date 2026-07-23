import type { Queue } from '@cw/ports';
import type { AppContext } from '../context.js';

/** Queue topic that carries relayed domain events to the worker dispatcher. */
export const EVENTS_TOPIC = 'cw.events';

/**
 * Drains the transactional outbox: reads pending events, enqueues each onto the
 * events topic, and marks them relayed. Because events were appended in the same
 * transaction as the state change, this guarantees at-least-once delivery with
 * no lost events. Returns the number relayed.
 *
 * The read + enqueue + mark run inside one transaction so concurrent relayers
 * (the edge post-commit nudge racing the cron sweeper, or multiple workers)
 * skip each other's claimed rows instead of double-enqueueing — the Postgres
 * repo reads pending rows with `FOR UPDATE SKIP LOCKED`. A crash after enqueue
 * but before commit re-delivers (at-least-once), never loses.
 */
export async function relayOutbox(
  ctx: AppContext,
  queue: Queue,
  opts: { batchSize?: number } = {},
): Promise<number> {
  return ctx.store.withTransaction(async (tx) => {
    const batch = await tx.outbox.readPending(opts.batchSize ?? 250);
    if (batch.length === 0) return 0;
    // dedupeKey: queues that support producer-side dedupe (BullMQ job ids)
    // collapse the crash-between-enqueue-and-commit redelivery; queues that
    // don't (Cloudflare Queues) ignore it — consumers stay idempotent.
    await queue.enqueueMany(
      EVENTS_TOPIC,
      batch.map((event) => ({ payload: event, dedupeKey: event.id })),
    );
    await tx.outbox.markRelayed(batch.map((e) => e.id));
    return batch.length;
  });
}

/**
 * Repeatedly relays until the outbox is empty or `maxIterations` is reached —
 * so a burst larger than one batch (a bulk publish) drains in one trigger
 * instead of waiting out successive cron ticks. Returns the total relayed.
 */
export async function drainOutbox(
  ctx: AppContext,
  queue: Queue,
  opts: { batchSize?: number; maxIterations?: number } = {},
): Promise<number> {
  const maxIterations = opts.maxIterations ?? 10;
  let total = 0;
  for (let i = 0; i < maxIterations; i++) {
    const relayed = await relayOutbox(ctx, queue, opts);
    total += relayed;
    if (relayed === 0) break;
  }
  return total;
}

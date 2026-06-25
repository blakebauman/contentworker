import type { Queue } from '@cw/ports';
import type { AppContext } from '../context.js';

/** Queue topic that carries relayed domain events to the worker dispatcher. */
export const EVENTS_TOPIC = 'cw.events';

/**
 * Drains the transactional outbox: reads pending events, enqueues each onto the
 * events topic, and marks them relayed. Because events were appended in the same
 * transaction as the state change, this guarantees at-least-once delivery with
 * no lost events. Returns the number relayed.
 */
export async function relayOutbox(
  ctx: AppContext,
  queue: Queue,
  opts: { batchSize?: number } = {},
): Promise<number> {
  const batch = await ctx.store.outbox.readPending(opts.batchSize ?? 100);
  if (batch.length === 0) return 0;
  for (const event of batch) {
    await queue.enqueue(EVENTS_TOPIC, event);
  }
  await ctx.store.outbox.markRelayed(batch.map((e) => e.id));
  return batch.length;
}

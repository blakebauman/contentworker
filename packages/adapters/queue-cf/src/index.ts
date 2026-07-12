import type { Queue, Subscription } from '@cw/ports';

/** The subset of a Cloudflare Queues producer binding this adapter uses. */
export interface CfQueueBinding {
  send(message: unknown, options?: { delaySeconds?: number }): Promise<unknown>;
}

/**
 * Produce-only Queue adapter over Cloudflare Queues producer bindings, keyed
 * by topic. `process()` throws: on Cloudflare, consumers are declarative — the
 * `queue()` handler in the edge composition root routes batches to
 * `consumeEvent` — so nothing should ever subscribe through this port there.
 *
 * `dedupeKey` is accepted but ignored (Cloudflare Queues has no producer-side
 * dedupe); event dispatch is idempotent on the event id, so at-least-once
 * delivery already covers duplicates.
 */
export function createCfQueueProducer(bindings: Record<string, CfQueueBinding>): Queue {
  return {
    async enqueue(topic, payload, opts) {
      const binding = bindings[topic];
      if (!binding) throw new Error(`No Cloudflare queue binding for topic "${topic}"`);
      await binding.send(payload, {
        ...(opts?.delayMs ? { delaySeconds: Math.ceil(opts.delayMs / 1000) } : {}),
      });
    },
    process(topic): Subscription {
      throw new Error(
        `Queue.process("${topic}") is not supported on Cloudflare — consumers are wired as queue() handlers in apps/edge`,
      );
    },
  };
}

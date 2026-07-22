import type { Queue as QueuePort, Subscription } from '@cw/ports';
import { Queue as BullQueue, type ConnectionOptions, Worker } from 'bullmq';
import type { Redis } from 'ioredis';

/**
 * BullMQ-backed Queue adapter. One BullMQ Queue/Worker per topic. BullMQ
 * provides retries, backoff, and delayed jobs; the `Queue` port keeps SQS/NATS
 * swappable.
 *
 * The ioredis instance is cast to BullMQ's `ConnectionOptions`: an ioredis
 * client is a valid BullMQ connection at runtime, but BullMQ bundles its own
 * pinned ioredis whose nominal type differs from ours.
 */
export function createRedisQueue(redis: Redis): QueuePort & { close(): Promise<void> } {
  const connection = redis as unknown as ConnectionOptions;
  const queues = new Map<string, BullQueue>();
  const workers: Worker[] = [];

  const queueFor = (topic: string): BullQueue => {
    let q = queues.get(topic);
    if (!q) {
      q = new BullQueue(topic, { connection });
      queues.set(topic, q);
    }
    return q;
  };

  return {
    async enqueue(topic, payload, opts) {
      const q = queueFor(topic);
      if (opts?.dedupeKey) {
        // BullMQ's jobId dedupe is a silent no-op against a retained job in
        // ANY state — including `failed`. A failed twin must not swallow a
        // legitimate re-enqueue (the outbox re-relays exactly when delivery
        // is in doubt), so give it a fresh attempt cycle instead.
        const existing = await q.getJob(opts.dedupeKey);
        if (existing) {
          if (await existing.isFailed()) await existing.retry();
          return;
        }
      }
      await q.add(topic, payload, {
        delay: opts?.delayMs,
        jobId: opts?.dedupeKey,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: 1000,
        removeOnFail: 5000,
      });
    },
    process(topic, handler): Subscription {
      const worker = new Worker(topic, async (job) => handler(job.data), { connection });
      workers.push(worker);
      return { close: () => worker.close() };
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
    },
  };
}

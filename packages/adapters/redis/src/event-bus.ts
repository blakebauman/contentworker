import type { DomainEvent } from '@cw/domain';
import type { EventBus, Subscription } from '@cw/ports';
import type { Redis } from 'ioredis';

/** The single Redis pub/sub channel domain events fan out over. */
const CHANNEL = 'cw.live';

/** True if `type` matches `pattern` ('*' = all, trailing '*' = prefix). */
function matches(pattern: string, type: string): boolean {
  if (!pattern || pattern === '*') return true;
  if (pattern.endsWith('*')) return type.startsWith(pattern.slice(0, -1));
  return pattern === type;
}

/**
 * Redis pub/sub EventBus. The worker `publish`es relayed domain events; the API
 * process `subscribe`s to stream them to Live Content API clients. A subscriber
 * connection cannot issue normal commands, so each subscription duplicates the
 * connection (ioredis pub/sub requirement).
 */
export function createRedisEventBus(redis: Redis): EventBus & { close(): Promise<void> } {
  const subs: Redis[] = [];
  return {
    async publish(event: DomainEvent): Promise<void> {
      await redis.publish(CHANNEL, JSON.stringify(event));
    },
    subscribe(pattern: string, handler: (event: DomainEvent) => Promise<void>): Subscription {
      const sub = redis.duplicate();
      subs.push(sub);
      void sub.subscribe(CHANNEL);
      sub.on('message', (_channel: string, message: string) => {
        let event: DomainEvent;
        try {
          event = JSON.parse(message) as DomainEvent;
        } catch {
          return;
        }
        if (matches(pattern, event.type)) void handler(event);
      });
      return {
        close: async () => {
          await sub.unsubscribe(CHANNEL).catch(() => {});
          sub.disconnect();
        },
      };
    },
    async close(): Promise<void> {
      for (const s of subs) s.disconnect();
    },
  };
}

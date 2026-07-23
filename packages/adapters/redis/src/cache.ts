import type { Cache } from '@cw/ports';
import type { Redis } from 'ioredis';

const tagKey = (tag: string) => `cwtag:${tag}`;

/**
 * Redis-backed delivery cache with tag-based invalidation. Each cached key is
 * added to a Redis set per tag; invalidating a tag deletes every member key.
 */
export function createRedisCache(connection: Redis, defaultTtlSeconds = 300): Cache {
  return {
    async get(key) {
      return connection.get(key);
    },
    async set(key, value, opts) {
      const ttl = opts?.ttlSeconds ?? defaultTtlSeconds;
      await connection.set(key, value, 'EX', ttl);
      const tags = opts?.tags ?? [];
      if (tags.length > 0) {
        const pipe = connection.pipeline();
        for (const tag of tags) {
          pipe.sadd(tagKey(tag), key);
          // Tag sets live a bit longer than entries so dangling members self-expire.
          pipe.expire(tagKey(tag), ttl + 60);
        }
        await pipe.exec();
      }
    },
    async invalidateTag(tag) {
      const members = await connection.smembers(tagKey(tag));
      const pipe = connection.pipeline();
      for (const key of members) pipe.del(key);
      pipe.del(tagKey(tag));
      await pipe.exec();
    },
    async invalidateTags(tags) {
      const distinct = [...new Set(tags)];
      if (distinct.length === 0) return;
      // One round-trip for all member lookups, then one delete pipeline.
      const memberLists = await Promise.all(
        distinct.map((tag) => connection.smembers(tagKey(tag))),
      );
      const pipe = connection.pipeline();
      for (const members of memberLists) for (const key of members) pipe.del(key);
      for (const tag of distinct) pipe.del(tagKey(tag));
      await pipe.exec();
    },
  };
}

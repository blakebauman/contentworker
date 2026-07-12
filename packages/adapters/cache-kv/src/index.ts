import type { Cache } from '@cw/ports';
import { v7 as uuidv7 } from 'uuid';

/** The subset of a Workers KV namespace binding this adapter uses. */
export interface KvBinding {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

interface CachedEnvelope {
  readonly value: string;
  /** Tag versions captured at write time; any drift means the entry is stale. */
  readonly tags: { tag: string; ver: string }[];
}

const valueKey = (key: string) => `c:${key}`;
const tagKey = (tag: string) => `tv:${tag}`;

/** Workers KV enforces a 60-second minimum expiration TTL. */
const MIN_KV_TTL_SECONDS = 60;

/**
 * Workers KV Cache with tag-based invalidation via tag-version keys:
 * `invalidateTag` writes a new version under `tv:<tag>`; `set` snapshots the
 * current versions of its tags into the envelope; `get` re-reads them and
 * treats any mismatch as a miss (lazy eviction).
 *
 * Consistency note: KV propagates writes to remote points of presence
 * eventually (worst case ~60s for a hot key), so a just-published entry may be
 * served stale elsewhere for up to that window — CDN-class semantics, applied
 * only to the Delivery API. Strict-freshness deployments run uncached.
 */
export function createKvCache(kv: KvBinding): Cache {
  const readVersions = (tags: readonly string[]) =>
    Promise.all(tags.map(async (tag) => ({ tag, ver: (await kv.get(tagKey(tag))) ?? '0' })));

  return {
    async get(key) {
      const raw = await kv.get(valueKey(key));
      if (raw === null) return null;
      let envelope: CachedEnvelope;
      try {
        envelope = JSON.parse(raw) as CachedEnvelope;
      } catch {
        return null;
      }
      if (envelope.tags.length > 0) {
        const current = await readVersions(envelope.tags.map((t) => t.tag));
        const fresh = envelope.tags.every((t, i) => current[i]?.ver === t.ver);
        if (!fresh) return null;
      }
      return envelope.value;
    },

    async set(key, value, opts) {
      const tags = await readVersions(opts?.tags ?? []);
      const envelope: CachedEnvelope = { value, tags };
      await kv.put(valueKey(key), JSON.stringify(envelope), {
        ...(opts?.ttlSeconds
          ? { expirationTtl: Math.max(MIN_KV_TTL_SECONDS, opts.ttlSeconds) }
          : {}),
      });
    },

    async invalidateTag(tag) {
      await kv.put(tagKey(tag), uuidv7());
    },
  };
}

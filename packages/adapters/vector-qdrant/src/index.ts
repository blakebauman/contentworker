import type { Scope } from '@cw/domain';
import type { VectorMatch, VectorRow, VectorStore } from '@cw/ports';

export interface QdrantStoreOptions {
  /** Qdrant HTTP endpoint, e.g. `http://qdrant:6333` or a Qdrant Cloud URL. */
  url?: string;
  /** api-key header; omit for unauthenticated local instances. */
  apiKey?: string;
  /** Collection name (created on first use). */
  collection?: string;
  /** Embedding dimension — fixes the collection's vector size. */
  dimensions?: number;
  /** Recorded on each point so an embedding-model swap is detectable. */
  modelId?: string;
}

const encoder = new TextEncoder();

/** Deterministic UUID (v8-shaped) from SHA-256 — Qdrant point ids must be UUIDs. */
async function pointId(input: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(input));
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

const scopeFilter = (scope: Scope) => ({
  must: [
    { key: 'space_id', match: { value: scope.spaceId } },
    { key: 'environment_id', match: { value: scope.environmentId } },
  ],
});

/**
 * Qdrant-backed VectorStore — the self-hostable swap for pgvector/Vectorize.
 * Plain fetch (Node + Workers). Multi-tenancy via payload filters on
 * space_id/environment_id (payload-indexed); point ids are deterministic
 * hashes of scope+entry+locale+chunk so re-upserts replace in place.
 */
export function createQdrantStore(opts: QdrantStoreOptions = {}): VectorStore {
  const baseUrl = (opts.url || process.env.QDRANT_URL || 'http://localhost:6333').replace(
    /\/$/,
    '',
  );
  const apiKey = opts.apiKey || process.env.QDRANT_API_KEY;
  const collection = opts.collection || process.env.QDRANT_COLLECTION || 'cw_embeddings';
  const dimensions = opts.dimensions ?? 1536;

  const headers = {
    'content-type': 'application/json',
    ...(apiKey ? { 'api-key': apiKey } : {}),
  };

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `qdrant ${method} ${path} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
      );
    }
    return res.json().catch(() => undefined);
  }

  // Lazily ensure the collection + payload indexes exist (idempotent; created
  // once per process). Payload indexes make the scope filter cheap.
  let ensured: Promise<void> | undefined;
  function ensureCollection(): Promise<void> {
    // On failure the memo is cleared so the next call retries — a transient
    // outage during the first ensure must not poison the adapter until restart.
    ensured ??= doEnsure().catch((err) => {
      ensured = undefined;
      throw err;
    });
    return ensured;
  }
  async function doEnsure(): Promise<void> {
    const exists = await fetch(`${baseUrl}/collections/${collection}`, { headers });
    if (exists.status === 404) {
      await call('PUT', `/collections/${collection}`, {
        vectors: { size: dimensions, distance: 'Cosine' },
      }).catch((err) => {
        // A concurrent creator winning the race is fine.
        if (!String(err).includes('already exists')) throw err;
      });
    } else if (!exists.ok) {
      const detail = await exists.text().catch(() => '');
      throw new Error(`qdrant collection check failed: ${exists.status} — ${detail.slice(0, 300)}`);
    }
    for (const field of ['space_id', 'environment_id', 'entry_id']) {
      await call('PUT', `/collections/${collection}/index?wait=true`, {
        field_name: field,
        field_schema: 'keyword',
      }).catch((err) => {
        if (!String(err).includes('already exists')) throw err;
      });
    }
  }

  return {
    async upsert(rows: VectorRow[]) {
      if (rows.length === 0) return;
      await ensureCollection();
      const points = await Promise.all(
        rows.map(async (row) => ({
          // Components are encoded before joining so an embedded ':' in a
          // caller-chosen id can never collide with the delimiter.
          id: await pointId(
            `${[row.scope.spaceId, row.scope.environmentId, row.entryId, row.locale]
              .map(encodeURIComponent)
              .join(':')}:${row.chunkIndex}`,
          ),
          vector: row.embedding,
          payload: {
            space_id: row.scope.spaceId,
            environment_id: row.scope.environmentId,
            entry_id: row.entryId,
            locale: row.locale,
            chunk_index: row.chunkIndex,
            chunk_text: row.chunkText,
            entry_version: row.entryVersion,
            model_id: opts.modelId,
          },
        })),
      );
      // No stale-chunk sweep here: `VectorStore.upsert` is not a replace —
      // callers (indexEntryEmbeddings) run deleteByEntry first, same contract
      // as the pgvector adapter. A chunk-count-based sweep would be wrong for
      // multi-locale batches (chunkIndex is per locale, rows.length is not).
      await call('PUT', `/collections/${collection}/points?wait=true`, { points });
    },

    async deleteByEntry(scope: Scope, entryId: string) {
      await ensureCollection();
      await call('POST', `/collections/${collection}/points/delete?wait=true`, {
        filter: {
          must: [...scopeFilter(scope).must, { key: 'entry_id', match: { value: entryId } }],
        },
      });
    },

    async query(
      scope: Scope,
      embedding: number[],
      opts2: { topK: number; minScore?: number },
    ): Promise<VectorMatch[]> {
      await ensureCollection();
      const result = (await call('POST', `/collections/${collection}/points/search`, {
        vector: embedding,
        limit: opts2.topK,
        filter: scopeFilter(scope),
        with_payload: true,
        ...(opts2.minScore !== undefined ? { score_threshold: opts2.minScore } : {}),
      })) as {
        result?: { score: number; payload?: { entry_id?: string; chunk_text?: string } }[];
      };
      return (result.result ?? [])
        .filter((m) => m.payload?.entry_id)
        .map((m) => ({
          entryId: m.payload?.entry_id as string,
          chunkText: m.payload?.chunk_text ?? '',
          score: m.score,
        }));
    },
  };
}

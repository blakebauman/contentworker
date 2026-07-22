import type { Scope } from '@cw/domain';
import type { LexicalSearchHit, SearchDoc, SearchIndex } from '@cw/ports';

export interface OpenSearchIndexOptions {
  /** OpenSearch HTTP endpoint, e.g. `https://opensearch:9200`. */
  url?: string;
  /** Basic-auth credentials; omit for unauthenticated clusters. */
  username?: string;
  password?: string;
  /** Index name (created with mappings on first use). */
  index?: string;
}

/** One document per published entry; `_id` is scope-qualified. Components are
 *  encoded before joining so an embedded ':' in a caller-chosen id can never
 *  collide with the delimiter; the whole id is encoded again for the URL. */
const docId = (scope: Scope, entryId: string) =>
  encodeURIComponent(
    [scope.spaceId, scope.environmentId, entryId].map(encodeURIComponent).join(':'),
  );

/**
 * OpenSearch-backed SearchIndex — the at-scale lexical leg (BM25) replacing
 * Postgres FTS when bound. Plain fetch (Node + Workers; also speaks the
 * Elasticsearch-compatible API surface it needs). Multi-tenancy via keyword
 * filters on space_id/environment_id. Query semantics mirror the store's
 * websearch behavior: every term must match (`operator: and`).
 */
export function createOpenSearchIndex(opts: OpenSearchIndexOptions = {}): SearchIndex {
  const baseUrl = (opts.url || process.env.OPENSEARCH_URL || 'http://localhost:9200').replace(
    /\/$/,
    '',
  );
  const username = opts.username || process.env.OPENSEARCH_USERNAME;
  const password = opts.password || process.env.OPENSEARCH_PASSWORD;
  const index = opts.index || process.env.OPENSEARCH_INDEX || 'cw-entries';

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (username && password) headers.authorization = `Basic ${btoa(`${username}:${password}`)}`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `opensearch ${method} ${path} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
      );
    }
    return res.json().catch(() => undefined);
  }

  // Lazily create the index with explicit mappings (idempotent per process).
  let ensured: Promise<void> | undefined;
  function ensureIndex(): Promise<void> {
    // On failure the memo is cleared so the next call retries — a transient
    // outage during the first ensure must not poison the adapter until restart.
    ensured ??= doEnsure().catch((err) => {
      ensured = undefined;
      throw err;
    });
    return ensured;
  }
  async function doEnsure(): Promise<void> {
    const exists = await fetch(`${baseUrl}/${index}`, { method: 'HEAD', headers });
    if (exists.status === 404) {
      await call('PUT', `/${index}`, {
        mappings: {
          properties: {
            space_id: { type: 'keyword' },
            environment_id: { type: 'keyword' },
            entry_id: { type: 'keyword' },
            content_type: { type: 'keyword' },
            entry_version: { type: 'integer' },
            text: { type: 'text' },
          },
        },
      }).catch((err) => {
        // A concurrent creator winning the race is fine.
        if (!String(err).includes('resource_already_exists')) throw err;
      });
    } else if (!exists.ok) {
      throw new Error(`opensearch index check failed: ${exists.status}`);
    }
  }

  return {
    async index(scope: Scope, doc: SearchDoc, opts2?: { refresh?: boolean }) {
      await ensureIndex();
      // refresh defaults to true: publish-time indexing is low-volume and
      // read-your-write matters more than throughput. Bulk callers (reindex
      // slices) pass refresh: false and ride the engine's refresh cycle.
      const refresh = opts2?.refresh ?? true;
      await call('PUT', `/${index}/_doc/${docId(scope, doc.entryId)}?refresh=${refresh}`, {
        space_id: scope.spaceId,
        environment_id: scope.environmentId,
        entry_id: doc.entryId,
        content_type: doc.contentTypeApiId,
        entry_version: doc.entryVersion,
        text: Object.values(doc.textByLocale).join('\n\n'),
      });
    },

    async remove(scope: Scope, entryId: string) {
      await ensureIndex();
      const res = await fetch(`${baseUrl}/${index}/_doc/${docId(scope, entryId)}?refresh=true`, {
        method: 'DELETE',
        headers,
      });
      // 404 = already gone (idempotent remove); anything else is an error.
      if (!res.ok && res.status !== 404) {
        throw new Error(`opensearch delete failed: ${res.status}`);
      }
    },

    async search(
      scope: Scope,
      query: string,
      opts2: { topK: number },
    ): Promise<LexicalSearchHit[]> {
      await ensureIndex();
      const result = (await call('POST', `/${index}/_search`, {
        size: opts2.topK,
        query: {
          bool: {
            filter: [
              { term: { space_id: scope.spaceId } },
              { term: { environment_id: scope.environmentId } },
            ],
            must: { match: { text: { query, operator: 'and' } } },
          },
        },
        _source: ['entry_id'],
      })) as {
        hits?: { hits?: { _score: number; _source?: { entry_id?: string } }[] };
      };
      return (result.hits?.hits ?? [])
        .filter((h) => h._source?.entry_id)
        .map((h) => ({ entryId: h._source?.entry_id as string, score: h._score }));
    },
  };
}

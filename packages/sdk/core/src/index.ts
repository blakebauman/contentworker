/**
 * @cw/sdk-core — the framework-agnostic Delivery client every channel SDK builds
 * on. Zero runtime dependencies; uses the platform `fetch` (injectable for SSR,
 * edge runtimes, and tests). Talks to the read-only Delivery API with a CDA token.
 */

/** Locale-keyed field values, or flattened values when a locale is requested. */
export type Fields = Record<string, unknown>;

/** A delivered entry. Generic `F` lets codegen supply a typed field shape. */
export interface DeliveredEntry<F extends Fields = Fields> {
  readonly id: string;
  readonly contentType: string;
  readonly fields: F;
  readonly publishedAt: string;
}

export interface SearchHit {
  readonly entryId: string;
  readonly score: number;
  readonly snippet: string;
}

export interface ClientOptions {
  /** Base URL of the Delivery API, e.g. https://cms.example.com */
  readonly baseUrl: string;
  readonly space: string;
  readonly environment: string;
  /** Content Delivery API (CDA) token. */
  readonly token: string;
  /** Override fetch (SSR/edge/tests). Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** In-memory response cache TTL (ms). 0 disables. Default 0. */
  readonly cacheTtlMs?: number;
}

export interface EntryQuery {
  readonly contentType?: string;
  readonly locale?: string;
  /** Reference resolution depth (embeds linked entries). */
  readonly include?: number;
  readonly limit?: number;
  readonly skip?: number;
}

export class DeliveryError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DeliveryError';
  }
}

interface CacheEntry {
  expires: number;
  value: unknown;
}

/** Creates a Delivery client bound to one space/environment. */
export function createDeliveryClient(opts: ClientOptions) {
  const doFetch = opts.fetch ?? globalThis.fetch;
  const ttl = opts.cacheTtlMs ?? 0;
  const cache = new Map<string, CacheEntry>();
  const base = `${opts.baseUrl.replace(/\/$/, '')}/delivery/${opts.space}/${opts.environment}`;

  async function get<T>(
    path: string,
    params: Record<string, string | number | undefined>,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') qs.set(k, String(v));
    }
    const url = `${base}${path}${qs.toString() ? `?${qs}` : ''}`;

    if (ttl > 0) {
      const hit = cache.get(url);
      if (hit && hit.expires > Date.now()) return hit.value as T;
    }

    const res = await doFetch(url, { headers: { authorization: `Bearer ${opts.token}` } });
    if (!res.ok) {
      throw new DeliveryError(res.status, `Delivery request failed: ${res.status} ${url}`);
    }
    const value = (await res.json()) as T;
    if (ttl > 0) cache.set(url, { expires: Date.now() + ttl, value });
    return value;
  }

  return {
    /** Fetch a single published entry by id. */
    async getEntry<F extends Fields = Fields>(
      id: string,
      o: Pick<EntryQuery, 'locale' | 'include'> = {},
    ): Promise<DeliveredEntry<F>> {
      return get<DeliveredEntry<F>>(`/entries/${encodeURIComponent(id)}`, {
        locale: o.locale,
        include: o.include,
      });
    },

    /** List published entries, optionally filtered/paginated. */
    async listEntries<F extends Fields = Fields>(
      q: EntryQuery = {},
    ): Promise<{ items: DeliveredEntry<F>[]; total: number }> {
      return get('/entries', {
        content_type: q.contentType,
        locale: q.locale,
        include: q.include,
        limit: q.limit,
        skip: q.skip,
      });
    },

    /** Semantic search over published content. */
    async search(query: string, o: { topK?: number } = {}): Promise<SearchHit[]> {
      const res = await get<{ hits: SearchHit[] }>('/search', { q: query, top_k: o.topK });
      return res.hits;
    },

    /** Chainable query builder for entries. */
    query: () => new EntryQueryBuilder<Fields>((q) => get('/entries', toParams(q))),

    /** Clears the in-memory response cache. */
    clearCache: () => cache.clear(),
  };
}

function toParams(q: EntryQuery): Record<string, string | number | undefined> {
  return {
    content_type: q.contentType,
    locale: q.locale,
    include: q.include,
    limit: q.limit,
    skip: q.skip,
  };
}

/** Fluent entry query: `client.query().contentType('article').locale('en-US').limit(10).fetch()`. */
export class EntryQueryBuilder<F extends Fields> {
  private q: EntryQuery = {};
  constructor(
    private readonly run: (q: EntryQuery) => Promise<{ items: DeliveredEntry<F>[]; total: number }>,
  ) {}
  contentType(apiId: string): this {
    this.q = { ...this.q, contentType: apiId };
    return this;
  }
  locale(code: string): this {
    this.q = { ...this.q, locale: code };
    return this;
  }
  include(depth: number): this {
    this.q = { ...this.q, include: depth };
    return this;
  }
  limit(n: number): this {
    this.q = { ...this.q, limit: n };
    return this;
  }
  skip(n: number): this {
    this.q = { ...this.q, skip: n };
    return this;
  }
  fetch(): Promise<{ items: DeliveredEntry<F>[]; total: number }> {
    return this.run(this.q);
  }
}

export type DeliveryClient = ReturnType<typeof createDeliveryClient>;

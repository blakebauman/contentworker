import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQdrantStore } from '../src/index.js';

const scope = { spaceId: 'space-1', environmentId: 'main' };

type Call = { method: string; url: string; body?: unknown };

function mockFetch(respond?: (call: Call) => unknown) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const call: Call = {
        method: init?.method ?? 'GET',
        url: String(url),
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      };
      calls.push(call);
      const body = respond?.(call) ?? {};
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => body,
        text: async () => JSON.stringify(body),
      };
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('createQdrantStore', () => {
  it('creates the collection + payload indexes once, then upserts points', async () => {
    const calls = mockFetch((c) => {
      // Collection existence check → 404 triggers creation.
      if (c.method === 'GET' && c.url.endsWith('/collections/cw_embeddings')) {
        return {};
      }
      return {};
    });
    // Make the existence check a 404 so the create path runs.
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockImplementationOnce(async (url: string) => ({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      json: async () => ({}),
      text: async () => '',
      url,
    }));

    const store = createQdrantStore({ url: 'http://qdrant:6333', dimensions: 4 });
    await store.upsert([
      {
        scope,
        entryId: 'e1',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'hello',
        embedding: [0.1, 0.2, 0.3, 0.4],
        entryVersion: 1,
      },
    ]);

    const create = calls.find(
      (c) => c.method === 'PUT' && c.url.endsWith('/collections/cw_embeddings'),
    );
    expect(create?.body).toEqual({ vectors: { size: 4, distance: 'Cosine' } });
    const indexCalls = calls.filter((c) => c.url.includes('/index?wait=true'));
    expect(indexCalls.map((c) => (c.body as { field_name: string }).field_name)).toEqual([
      'space_id',
      'environment_id',
      'entry_id',
    ]);
    const upsert = calls.find((c) => c.url.endsWith('/points?wait=true'));
    const point = (upsert?.body as { points: { id: string; payload: Record<string, unknown> }[] })
      .points[0];
    expect(point?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(point?.payload.entry_id).toBe('e1');
    // No stale sweep: upsert is not a replace (callers deleteByEntry first).
    expect(calls.find((c) => c.url.endsWith('/points/delete?wait=true'))).toBeUndefined();
  });

  it('retries the collection ensure after a transient failure', async () => {
    let failures = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        // First ensure attempt: the backend is down entirely.
        if (failures === 0 && String(url).includes('/collections/')) {
          failures += 1;
          throw new TypeError('fetch failed');
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ result: [] }),
          text: async () => '',
        };
      }),
    );
    const store = createQdrantStore({ url: 'http://x:6333', dimensions: 2 });
    await expect(store.query(scope, [1, 0], { topK: 1 })).rejects.toThrow();
    // The failed ensure must not be memoized: the next call succeeds.
    await expect(store.query(scope, [1, 0], { topK: 1 })).resolves.toEqual([]);
  });

  it('produces stable point ids for the same identity', async () => {
    mockFetch();
    const store = createQdrantStore({ url: 'http://x:6333', dimensions: 2 });
    const row = {
      scope,
      entryId: 'e1',
      locale: 'en-US',
      chunkIndex: 0,
      chunkText: 't',
      embedding: [1, 0],
      entryVersion: 1,
    };
    await store.upsert([row]);
    const first = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([u, i]: [string, RequestInit]) => ({ u, b: i?.body }))
      .find((c) => c.u.endsWith('/points?wait=true'));
    await store.upsert([{ ...row, entryVersion: 2 }]);
    const second = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([u, i]: [string, RequestInit]) => ({ u, b: i?.body }))
      .filter((c) => c.u.endsWith('/points?wait=true'))
      .at(-1);
    const id = (b: unknown) => JSON.parse(b as string).points[0].id;
    expect(id(first?.b)).toBe(id(second?.b));
  });

  it('queries with the tenant scope filter and maps matches', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/points/search')) {
        return {
          result: [
            { score: 0.9, payload: { entry_id: 'e1', chunk_text: 'hello world' } },
            { score: 0.5, payload: { entry_id: 'e2', chunk_text: 'other' } },
          ],
        };
      }
      return {};
    });
    const store = createQdrantStore({ url: 'http://x:6333', dimensions: 2 });
    const matches = await store.query(scope, [1, 0], { topK: 5, minScore: 0.1 });
    expect(matches).toEqual([
      { entryId: 'e1', chunkText: 'hello world', score: 0.9 },
      { entryId: 'e2', chunkText: 'other', score: 0.5 },
    ]);
    const search = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([u, i]: [string, RequestInit]) => ({
        u,
        b: i?.body ? JSON.parse(i.body as string) : undefined,
      }))
      .find((c) => c.u.endsWith('/points/search'));
    expect(search?.b.filter.must).toEqual([
      { key: 'space_id', match: { value: 'space-1' } },
      { key: 'environment_id', match: { value: 'main' } },
    ]);
    expect(search?.b.limit).toBe(5);
    expect(search?.b.score_threshold).toBe(0.1);
  });

  it('deletes by entry with a filter (no id enumeration)', async () => {
    mockFetch();
    const store = createQdrantStore({ url: 'http://x:6333' });
    await store.deleteByEntry(scope, 'e9');
    const del = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([u, i]: [string, RequestInit]) => ({
        u,
        b: i?.body ? JSON.parse(i.body as string) : undefined,
      }))
      .find((c) => c.u.endsWith('/points/delete?wait=true'));
    expect(JSON.stringify(del?.b)).toContain('"entry_id"');
    expect(JSON.stringify(del?.b)).toContain('"e9"');
  });

  it('surfaces server errors with status context', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable',
        json: async () => ({}),
        text: async () => 'overloaded',
      })),
    );
    const store = createQdrantStore({ url: 'http://x:6333' });
    await expect(store.deleteByEntry(scope, 'e1')).rejects.toThrow(/503/);
  });
});

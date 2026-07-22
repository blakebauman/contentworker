import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenSearchIndex } from '../src/index.js';

const scope = { spaceId: 'space-1', environmentId: 'main' };

type Call = { method: string; url: string; body?: unknown };

function mockFetch(respond?: (call: Call) => { status?: number; body?: unknown }) {
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
      const res = respond?.(call) ?? {};
      const status = res.status ?? 200;
      return {
        ok: status < 400,
        status,
        statusText: 'x',
        json: async () => res.body ?? {},
        text: async () => JSON.stringify(res.body ?? {}),
      };
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe('createOpenSearchIndex', () => {
  it('creates the index with mappings when absent, then upserts the doc', async () => {
    const calls = mockFetch((c) => {
      if (c.method === 'HEAD') return { status: 404 };
      return {};
    });
    const idx = createOpenSearchIndex({ url: 'http://os:9200' });
    await idx.index(scope, {
      entryId: 'e1',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'Hello world', 'de-DE': 'Hallo Welt' },
      entryVersion: 3,
    });

    const create = calls.find((c) => c.method === 'PUT' && c.url.endsWith('/cw-entries'));
    expect(
      (create?.body as { mappings: { properties: Record<string, unknown> } }).mappings.properties
        .space_id,
    ).toEqual({ type: 'keyword' });

    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/_doc/'));
    expect(put?.url).toContain(encodeURIComponent('space-1:main:e1'));
    expect(put?.url).toContain('refresh=true');
    const doc = put?.body as Record<string, unknown>;
    expect(doc.entry_id).toBe('e1');
    expect(doc.text).toContain('Hello world');
    expect(doc.text).toContain('Hallo Welt');
  });

  it('searches with tenant filters and AND term semantics', async () => {
    mockFetch((c) => {
      if (c.url.endsWith('/_search')) {
        return {
          body: {
            hits: {
              hits: [
                { _score: 2.4, _source: { entry_id: 'e1' } },
                { _score: 1.1, _source: { entry_id: 'e2' } },
              ],
            },
          },
        };
      }
      return {};
    });
    const idx = createOpenSearchIndex({ url: 'http://os:9200' });
    const hits = await idx.search(scope, 'hello world', { topK: 7 });
    expect(hits).toEqual([
      { entryId: 'e1', score: 2.4 },
      { entryId: 'e2', score: 1.1 },
    ]);
    const search = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([u, i]: [string, RequestInit]) => ({
        u,
        b: i?.body ? JSON.parse(i.body as string) : undefined,
      }))
      .find((c) => c.u.endsWith('/_search'));
    expect(search?.b.size).toBe(7);
    expect(search?.b.query.bool.filter).toEqual([
      { term: { space_id: 'space-1' } },
      { term: { environment_id: 'main' } },
    ]);
    expect(search?.b.query.bool.must.match.text.operator).toBe('and');
  });

  it('treats delete of a missing doc as idempotent success', async () => {
    mockFetch((c) => (c.method === 'DELETE' ? { status: 404 } : {}));
    const idx = createOpenSearchIndex({ url: 'http://os:9200' });
    await expect(idx.remove(scope, 'gone')).resolves.toBeUndefined();
  });

  it('sends basic auth only when credentials are configured', async () => {
    mockFetch();
    await createOpenSearchIndex({ url: 'http://os:9200' }).search(scope, 'q', { topK: 1 });
    const bare = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[1] as RequestInit;
    expect((bare.headers as Record<string, string>).authorization).toBeUndefined();

    await createOpenSearchIndex({
      url: 'http://os:9200',
      username: 'admin',
      password: 'pw',
    }).search(scope, 'q', { topK: 1 });
    const authed = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.at(
      -1,
    )?.[1] as RequestInit;
    expect((authed.headers as Record<string, string>).authorization).toBe(
      `Basic ${btoa('admin:pw')}`,
    );
  });

  it('retries the index ensure after a transient failure', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;
        // First ensure attempt (HEAD) is a hard 500; everything after is fine.
        if (calls === 1) {
          return {
            ok: false,
            status: 500,
            statusText: 'x',
            json: async () => ({}),
            text: async () => '',
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: 'OK',
          json: async () => ({ hits: { hits: [] } }),
          text: async () => '',
        };
      }),
    );
    const idx = createOpenSearchIndex({ url: 'http://os:9200' });
    await expect(idx.search(scope, 'q', { topK: 1 })).rejects.toThrow(/index check failed/);
    // The failed ensure must not be memoized: the next call succeeds.
    await expect(idx.search(scope, 'q', { topK: 1 })).resolves.toEqual([]);
  });

  it('passes refresh=false through for bulk callers', async () => {
    mockFetch();
    const idx = createOpenSearchIndex({ url: 'http://os:9200' });
    await idx.index(
      scope,
      { entryId: 'e1', contentTypeApiId: 'a', textByLocale: { 'en-US': 't' }, entryVersion: 1 },
      { refresh: false },
    );
    const put = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls
      .map(([u]: [string]) => u)
      .find((u: string) => u.includes('/_doc/'));
    expect(put).toContain('refresh=false');
  });

  it('surfaces server errors with status context', async () => {
    mockFetch((c) => (c.url.endsWith('/_search') ? { status: 500, body: { error: 'boom' } } : {}));
    const idx = createOpenSearchIndex({ url: 'http://os:9200' });
    await expect(idx.search(scope, 'q', { topK: 1 })).rejects.toThrow(/500/);
  });
});

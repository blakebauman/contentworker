import { describe, expect, it, vi } from 'vitest';
import { ApiError, type Connection, createManagementClient } from '../src/lib/management.js';

const conn: Connection = {
  baseUrl: 'https://cms.test',
  token: 'cma-tok',
  space: 's1',
  environment: 'main',
  locale: 'en-US',
};

function fakeFetch(handler: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const body = handler(url, init);
    return body instanceof Response ? body : new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('admin ManagementClient', () => {
  it('lists content types from the management base with bearer auth', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [{ apiId: 'article', name: 'Article' }] }));
    const client = createManagementClient(conn, fn);
    const types = await client.listContentTypes();
    expect(types[0]?.apiId).toBe('article');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/content-types');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer cma-tok',
    );
  });

  it('lists entries from the PREVIEW base (drafts), filtered by content type', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [] }));
    const client = createManagementClient(conn, fn);
    await client.listEntries('article');
    expect(calls[0]?.url).toBe('https://cms.test/preview/s1/main/entries?content_type=article');
  });

  it('sends localized fields through on create (the form owns localization)', async () => {
    const { fn, calls } = fakeFetch(() => ({ entry: { id: 'e1' }, fields: {} }));
    const client = createManagementClient(conn, fn);
    await client.createEntry('article', { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } });
    const body = JSON.parse((calls[0]?.init?.body as string) ?? '{}');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/entries');
    expect(body).toEqual({
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Hi', 'de-DE': 'Hallo' } },
    });
  });

  it('reads space config (locales) from the management base', async () => {
    const { fn, calls } = fakeFetch(() => ({
      spaceId: 's1',
      name: 'Space 1',
      defaultLocale: 'en-US',
      locales: ['en-US', 'de-DE'],
    }));
    const client = createManagementClient(conn, fn);
    const cfg = await client.getSpaceConfig();
    expect(cfg.locales).toEqual(['en-US', 'de-DE']);
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/space-config');
  });

  it('publishes via the management entries action', async () => {
    const { fn, calls } = fakeFetch(() => ({ id: 'e1', status: 'published' }));
    const client = createManagementClient(conn, fn);
    await client.publishEntry('e1');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/entries/e1/published');
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('uploadAsset creates → PUTs bytes to the presigned URL → publishes', async () => {
    const seq: string[] = [];
    const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seq.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/assets')) {
        return new Response(
          JSON.stringify({
            asset: { id: 'asset_1', status: 'draft' },
            upload: { url: 'https://blob.test/put?sig', headers: { 'content-type': 'text/plain' } },
          }),
          { status: 201 },
        );
      }
      if (url === 'https://blob.test/put?sig') return new Response('', { status: 200 }); // presigned PUT
      return new Response(JSON.stringify({ id: 'asset_1', status: 'published' }), { status: 200 });
    }) as unknown as typeof fetch;

    const client = createManagementClient(conn, fn);
    const file = new File(['hello'], 'note.txt', { type: 'text/plain' });
    const published = await client.uploadAsset(file);
    expect(published.status).toBe('published');
    expect(seq).toEqual([
      'POST https://cms.test/spaces/s1/environments/main/assets',
      'PUT https://blob.test/put?sig',
      'POST https://cms.test/spaces/s1/environments/main/assets/asset_1/published',
    ]);
  });

  it('lists assets from the management base', async () => {
    const { fn, calls } = fakeFetch(() => ({ items: [{ id: 'a1' }] }));
    const client = createManagementClient(conn, fn);
    const assets = await client.listAssets();
    expect(assets[0]?.id).toBe('a1');
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/assets');
  });

  it('reads agent runs + usage from management, and searches via delivery', async () => {
    const { fn, calls } = fakeFetch((url) => {
      if (url.includes('/agent-runs/usage')) return { runs: 2, inputTokens: 300, outputTokens: 50 };
      if (url.includes('/agent-runs'))
        return {
          items: [
            {
              id: 'r1',
              workflow: 'enrich',
              status: 'completed',
              inputTokens: 100,
              outputTokens: 20,
              decisions: [],
              entryId: 'e1',
              createdAt: 'now',
            },
          ],
        };
      return { hits: [{ entryId: 'e1', score: 0.9, snippet: 'hi' }] };
    });
    const client = createManagementClient(conn, fn);

    expect((await client.listAgentRuns())[0]?.workflow).toBe('enrich');
    expect((await client.agentUsage()).inputTokens).toBe(300);
    expect((await client.search('database'))[0]?.entryId).toBe('e1');

    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/agent-runs');
    expect(calls[1]?.url).toBe('https://cms.test/spaces/s1/environments/main/agent-runs/usage');
    expect(calls[2]?.url).toBe('https://cms.test/delivery/s1/main/search?q=database');
  });

  it('reads the published version via delivery (for diff), rendered for the locale', async () => {
    const { fn, calls } = fakeFetch(() => ({
      id: 'e1',
      contentType: 'article',
      fields: { title: 'Published' },
      publishedAt: 'then',
    }));
    const client = createManagementClient(conn, fn);
    const pub = await client.getPublished('e1');
    expect(pub.fields.title).toBe('Published');
    expect(calls[0]?.url).toBe('https://cms.test/delivery/s1/main/entries/e1?locale=en-US');
  });

  it('manages API keys at the space base (list + mint with one-time token)', async () => {
    const { fn, calls } = fakeFetch((_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return { items: [{ id: 'k1', kind: 'cda', scopes: ['delivery:read'], revoked: false }] };
      }
      return { id: 'k2', kind: 'cma', token: 'cw_cma_secret' };
    });
    const client = createManagementClient(conn, fn);

    expect((await client.listApiKeys())[0]?.kind).toBe('cda');
    const minted = await client.createApiKey({ kind: 'cma', name: 'CI' });
    expect(minted.token).toBe('cw_cma_secret');

    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/api-keys'); // space-scoped, no env
    expect(calls[1]?.init?.method).toBe('POST');
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '{}')).toEqual({
      kind: 'cma',
      name: 'CI',
    });
  });

  it('manages webhooks at the environment base', async () => {
    const { fn, calls } = fakeFetch(() => ({
      id: 'w1',
      url: 'https://x.test',
      topics: ['*'],
      active: true,
    }));
    const client = createManagementClient(conn, fn);
    await client.createWebhook({ url: 'https://x.test', secret: 's', topics: ['entry.published'] });
    expect(calls[0]?.url).toBe('https://cms.test/spaces/s1/environments/main/webhooks');
    expect(JSON.parse((calls[0]?.init?.body as string) ?? '{}').topics).toEqual([
      'entry.published',
    ]);
  });

  it('throws ApiError with status on non-2xx', async () => {
    const { fn } = fakeFetch(() => new Response('forbidden', { status: 403 }));
    const client = createManagementClient(conn, fn);
    await expect(client.listContentTypes()).rejects.toBeInstanceOf(ApiError);
    await expect(client.listContentTypes()).rejects.toMatchObject({ status: 403 });
  });
});

import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import type { ApiConfig } from '../src/config.js';
import { wire } from '../src/wire.js';

const config: ApiConfig = {
  role: 'all',
  port: 0,
  cmaKey: 'cma',
  cdaKey: 'cda',
  cpaKey: 'cpa',
  adminToken: 'admin',
  seed: { spaceId: 's1', environmentId: 'master', defaultLocale: 'en-US', locales: ['en-US'] },
};

const cma = { Authorization: 'Bearer cma', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/master';

async function gql(app: ReturnType<typeof createApp>, query: string) {
  const res = await app.request('/delivery/s1/master/graphql', {
    method: 'POST',
    headers: { Authorization: 'Bearer cda', 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  return { status: res.status, body: (await res.json()) as { data?: Record<string, unknown>; errors?: unknown[] } };
}

describe('GraphQL Delivery (generated from content types)', () => {
  it('serves a generated schema and resolves published content', async () => {
    const { ctx, rag, blob } = wire(config);
    const app = createApp(ctx, config, rag, blob);

    // Author + publish an article via the Management API.
    await app.request(`${M}/content-types`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({
        apiId: 'article',
        name: 'Article',
        displayField: 'title',
        fields: [
          { apiId: 'title', name: 'Title', type: 'Symbol', localized: false, required: true, position: 0 },
          { apiId: 'views', name: 'Views', type: 'Integer', localized: false, required: false, position: 1 },
        ],
      }),
    });
    await app.request(`${M}/content-types/article/published`, { method: 'POST', headers: cma });
    const created = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: cma,
      body: JSON.stringify({ contentTypeApiId: 'article', fields: { title: { 'en-US': 'GraphQL works' }, views: { 'en-US': 7 } } }),
    });
    const { entry } = (await created.json()) as { entry: { id: string } };
    await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: cma });

    // Query it through the generated GraphQL schema.
    const one = await gql(app, `{ article(id: "${entry.id}", locale: "en-US") { _sys { id contentType } title views } }`);
    expect(one.status).toBe(200);
    expect(one.body.errors).toBeUndefined();
    const a = (one.body.data as { article: Record<string, unknown> }).article;
    expect((a._sys as { id: string }).id).toBe(entry.id);
    expect(a.title).toBe('GraphQL works');
    expect(a.views).toBe(7);

    const list = await gql(app, '{ articleCollection(locale: "en-US") { _sys { id } title } }');
    expect((list.body.data as { articleCollection: unknown[] }).articleCollection).toHaveLength(1);
  });

  it('requires the delivery scope', async () => {
    const { ctx, rag, blob } = wire(config);
    const app = createApp(ctx, config, rag, blob);
    const res = await app.request('/delivery/s1/master/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }, // no token
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    expect(res.status).toBe(401);
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
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
  seed: { spaceId: 's1', environmentId: 'main', defaultLocale: 'en-US', locales: ['en-US'] },
};

const admin = { Authorization: 'Bearer admin', 'Content-Type': 'application/json' };
const M = '/spaces/s1/environments/main';

const symbolField = (apiId: string, position: number) => ({
  apiId,
  name: apiId,
  type: 'Symbol',
  localized: false,
  required: false,
  position,
});

describe('granular RBAC over HTTP', () => {
  let app: ReturnType<typeof createApp>;
  let editor: Record<string, string>;
  let postId: string;
  let pageId: string;

  beforeEach(async () => {
    const { ctx, rag, blob, ai } = wire(config);
    app = createApp(ctx, config, rag, blob, ai);

    // Model two types; publish both.
    for (const apiId of ['post', 'page']) {
      await app.request(`${M}/content-types`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          apiId,
          name: apiId,
          displayField: 'title',
          fields: [symbolField('title', 0), symbolField('internalNotes', 1)],
        }),
      });
      await app.request(`${M}/content-types/${apiId}/published`, {
        method: 'POST',
        headers: admin,
      });
    }

    // Author + publish one entry per type (with a sensitive field set).
    const mkEntry = async (contentTypeApiId: string) => {
      const res = await app.request(`${M}/entries`, {
        method: 'POST',
        headers: admin,
        body: JSON.stringify({
          contentTypeApiId,
          fields: {
            title: { 'en-US': `A ${contentTypeApiId}` },
            internalNotes: { 'en-US': 'secret' },
          },
        }),
      });
      const { entry } = (await res.json()) as { entry: { id: string } };
      await app.request(`${M}/entries/${entry.id}/published`, { method: 'POST', headers: admin });
      return entry.id;
    };
    postId = await mkEntry('post');
    pageId = await mkEntry('page');

    // A custom role: full coarse scopes, but content-wise only `post`,
    // no publish action, internalNotes hidden.
    const roleRes = await app.request('/spaces/s1/roles', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({
        name: 'Post editor',
        scopes: ['content:write', 'content:publish', 'preview:read', 'delivery:read'],
        contentGrants: [
          {
            contentTypeApiId: 'post',
            actions: ['read', 'write'],
            deniedFields: ['internalNotes'],
          },
        ],
      }),
    });
    expect(roleRes.status).toBe(201);
    const role = (await roleRes.json()) as { id: string };

    const keyRes = await app.request('/spaces/s1/api-keys', {
      method: 'POST',
      headers: admin,
      body: JSON.stringify({ kind: 'cma', roleId: role.id }),
    });
    const { token } = (await keyRes.json()) as { token: string };
    editor = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  });

  it('allows granted writes and rejects ungranted types and fields', async () => {
    const ok = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ contentTypeApiId: 'post', fields: { title: { 'en-US': 'Mine' } } }),
    });
    expect(ok.status).toBe(201);

    const wrongType = await app.request(`${M}/entries`, {
      method: 'POST',
      headers: editor,
      body: JSON.stringify({ contentTypeApiId: 'page', fields: { title: { 'en-US': 'No' } } }),
    });
    expect(wrongType.status).toBe(403);

    const deniedField = await app.request(`${M}/entries/${postId}`, {
      method: 'PUT',
      headers: editor,
      body: JSON.stringify({ fields: { internalNotes: { 'en-US': 'sneaky' } } }),
    });
    expect(deniedField.status).toBe(403);
  });

  it('denies publish despite the coarse content:publish scope', async () => {
    const res = await app.request(`${M}/entries/${postId}/published`, {
      method: 'POST',
      headers: editor,
    });
    expect(res.status).toBe(403);
  });

  it('masks denied fields on management, preview, and delivery reads', async () => {
    const mgmt = (await (
      await app.request(`${M}/entries/${postId}`, { headers: editor })
    ).json()) as { fields: Record<string, unknown> };
    expect(mgmt.fields.title).toBeDefined();
    expect(mgmt.fields.internalNotes).toBeUndefined();

    const preview = (await (
      await app.request('/preview/s1/main/entries', { headers: editor })
    ).json()) as { items: { contentType: string; fields: Record<string, unknown> }[] };
    // Only `post` entries are visible, and the denied field is masked.
    expect(preview.items.every((e) => e.contentType === 'post')).toBe(true);
    expect(preview.items.every((e) => e.fields.internalNotes === undefined)).toBe(true);

    const delivery = (await (
      await app.request('/delivery/s1/main/entries', { headers: editor })
    ).json()) as { items: { contentType: string }[] };
    expect(delivery.items.map((e) => e.contentType)).toEqual(['post']);

    const deniedGet = await app.request(`/delivery/s1/main/entries/${pageId}`, {
      headers: editor,
    });
    expect(deniedGet.status).toBe(403);
  });

  it('kind-based keys and the admin token are unaffected', async () => {
    const full = (await (
      await app.request(`${M}/entries/${postId}`, { headers: admin })
    ).json()) as { fields: Record<string, unknown> };
    expect(full.fields.internalNotes).toBeDefined();
  });
});

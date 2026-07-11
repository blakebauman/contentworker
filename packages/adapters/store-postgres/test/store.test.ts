import { createHash } from 'node:crypto';
import type { AppContext } from '@cw/application';
import {
  authenticate,
  createApiKey,
  createAppExtension,
  createContentType,
  createEntry,
  createFunction,
  createRole,
  createSpace,
  deleteFunction,
  getEntry,
  getPublishedEntry,
  listAppExtensions,
  listFunctions,
  listPublishedEntries,
  listRoles,
  publishContentType,
  publishEntry,
  unpublishEntry,
  updateEntry,
  updateRole,
} from '@cw/application';
import type { Clock, IdGenerator } from '@cw/ports';
import { v7 as uuidv7 } from 'uuid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresStore } from '../src/store.js';

// Real-Postgres contract tests. They drive the adapter through the same
// application use-cases the API/MCP use, so they prove the SQL mappings, the
// JSONB query path, the published read model, the outbox, and transactions
// behave like the in-memory contract. Opt-in: set TEST_DATABASE_URL to a
// migrated database (the suite isolates itself with a unique space id per run).
const URL = process.env.TEST_DATABASE_URL;

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => uuidv7() };

describe.skipIf(!URL)('Postgres store (contract)', () => {
  let store: ReturnType<typeof createPostgresStore>;
  let ctx: AppContext;
  // Unique per run so repeated runs against the same database never collide.
  const spaceId = `t-${uuidv7()}`;
  const scope = { spaceId, environmentId: 'main' };

  beforeAll(async () => {
    store = createPostgresStore(URL as string);
    ctx = { store, clock, ids };
    await createSpace(ctx, { spaceId, name: 'Test', defaultLocale: 'en-US', locales: ['en-US'] });
    await createContentType(ctx, scope, {
      apiId: 'article',
      name: 'Article',
      displayField: 'title',
      fields: [
        {
          apiId: 'title',
          name: 'Title',
          type: 'Symbol',
          localized: false,
          required: true,
          position: 0,
        },
        {
          apiId: 'views',
          name: 'Views',
          type: 'Integer',
          localized: false,
          required: false,
          position: 1,
        },
      ],
    });
    await publishContentType(ctx, scope, 'article');
  });

  afterAll(async () => {
    await store.close();
  });

  it('persists a space config and content type', async () => {
    const cfg = await store.spaces.getConfig(scope);
    expect(cfg?.name).toBe('Test');
    const ct = await store.contentTypes.get(scope, 'article');
    expect(ct?.fields.map((f) => f.apiId)).toEqual(['title', 'views']);
  });

  it('creates, versions, and reads back a draft entry', async () => {
    const created = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'First' }, views: { 'en-US': 10 } },
    });
    const id = created.entry.id;

    const fetched = await getEntry(ctx, scope, id);
    expect(fetched.fields.title?.['en-US']).toBe('First');
    expect(fetched.entry.currentVersion).toBe(1);

    await updateEntry(ctx, scope, id, { title: { 'en-US': 'Edited' }, views: { 'en-US': 20 } });
    const versions = await store.entries.listVersions(scope, id);
    expect(versions).toHaveLength(2);
    const v1 = await store.entries.getVersion(scope, id, 1);
    expect(v1?.fields.title?.['en-US']).toBe('First');
  });

  it('publishes to the delivery read model and filters/orders over JSONB', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Alpha' }, views: { 'en-US': 5 } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Beta' }, views: { 'en-US': 99 } },
    });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);

    const single = await getPublishedEntry(ctx, scope, b.entry.id);
    expect((single.fields.title as Record<string, unknown>)['en-US']).toBe('Beta');

    // Field-level filter + order over the published JSONB read model.
    const highViews = await listPublishedEntries(ctx, scope, {
      contentTypeApiId: 'article',
      filters: [{ field: 'views', op: 'gte', value: 50 }],
      order: [{ field: 'views', direction: 'desc' }],
    });
    const titles = highViews.map((e) => (e.fields.title as Record<string, unknown>)['en-US']);
    expect(titles).toContain('Beta');
    expect(titles).not.toContain('Alpha');

    // Unpublish removes it from delivery.
    await unpublishEntry(ctx, scope, b.entry.id);
    const after = await listPublishedEntries(ctx, scope, {
      contentTypeApiId: 'article',
      filters: [{ field: 'views', op: 'gte', value: 50 }],
    });
    expect(after.map((e) => e.entry?.id ?? '')).not.toContain(b.entry.id);
  });

  it('ranks published entries with Postgres full-text search', async () => {
    const twice = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Quantum primer: quantum gates and qubits' } },
    });
    const once = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Gardening notes with a quantum aside' } },
    });
    await publishEntry(ctx, scope, twice.entry.id);
    await publishEntry(ctx, scope, once.entry.id);

    // Term frequency drives ts_rank: the double mention ranks first.
    const hits = await store.entries.searchPublished(scope, 'quantum', { topK: 5 });
    expect(hits.map((h) => h.entryId)).toEqual([twice.entry.id, once.entry.id]);
    expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 0);

    // websearch semantics: every term must match.
    const both = await store.entries.searchPublished(scope, 'quantum gardening', { topK: 5 });
    expect(both.map((h) => h.entryId)).toEqual([once.entry.id]);

    expect(await store.entries.searchPublished(scope, 'nonexistentterm', { topK: 5 })).toEqual([]);
  });

  it('appends to the outbox transactionally on publish', async () => {
    const e = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Outbox' } },
    });
    await publishEntry(ctx, scope, e.entry.id);
    const pending = await store.outbox.readPending(100);
    expect(pending.some((ev) => ev.type === 'entry.published')).toBe(true);
  });

  it('round-trips roles and role-bound API keys (granular RBAC)', async () => {
    const role = await createRole(ctx, spaceId, {
      name: 'Editor',
      description: 'Posts only',
      scopes: ['content:write', 'preview:read'],
      contentGrants: [
        { contentTypeApiId: 'article', actions: ['read', 'write'], deniedFields: ['views'] },
      ],
    });
    const listed = await listRoles(ctx, spaceId);
    expect(listed.map((r) => r.id)).toContain(role.id);

    const hasher = { hash: (v: string) => createHash('sha256').update(v).digest('hex') };
    const { token } = await createApiKey(ctx, hasher, {
      spaceId,
      kind: 'cma',
      roleId: role.id,
    });
    const principal = await authenticate(ctx, hasher, token);
    expect(principal.scopes).toEqual(['content:write', 'preview:read']);
    expect(principal.contentGrants?.[0]?.deniedFields).toEqual(['views']);

    await updateRole(ctx, spaceId, role.id, {
      name: 'Editor',
      scopes: ['preview:read'],
      contentGrants: [{ contentTypeApiId: '*', actions: ['read'] }],
    });
    const after = await authenticate(ctx, hasher, token);
    expect(after.scopes).toEqual(['preview:read']);
    expect(after.contentGrants?.[0]?.contentTypeApiId).toBe('*');
  });

  it('round-trips the functions repo', async () => {
    const fn = await createFunction(ctx, scope, {
      name: 'reindex',
      eventPattern: 'entry.*',
      url: 'https://example.com/hook',
    });
    const listed = await listFunctions(ctx, scope);
    expect(listed.map((f) => f.id)).toContain(fn.id);
    await deleteFunction(ctx, scope, fn.id);
    expect((await listFunctions(ctx, scope)).map((f) => f.id)).not.toContain(fn.id);
  });

  it('round-trips the app-extensions repo (incl. nullable field types)', async () => {
    const sidebar = await createAppExtension(ctx, scope, {
      name: 'widget',
      target: 'sidebar',
      entryUrl: 'https://example.com/widget',
    });
    const editor = await createAppExtension(ctx, scope, {
      name: 'color',
      target: 'field-editor',
      entryUrl: 'https://example.com/color',
      fieldTypes: ['Symbol'],
    });
    const apps = await listAppExtensions(ctx, scope);
    const byId = new Map(apps.map((a) => [a.id, a]));
    expect(byId.get(sidebar.id)?.fieldTypes).toBeUndefined();
    expect(byId.get(editor.id)?.fieldTypes).toEqual(['Symbol']);
  });
});

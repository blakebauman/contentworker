import { createHash } from 'node:crypto';
import type { AppContext } from '@cw/application';
import {
  authenticate,
  bulkEntryAction,
  createAgentReview,
  createAgentSchedule,
  createApiKey,
  createAppExtension,
  createContentType,
  createEntry,
  createFunction,
  createRole,
  createSpace,
  deleteAgentSchedule,
  deleteFunction,
  getEntry,
  getPublishedEntry,
  listAgentSchedules,
  listAppExtensions,
  listFunctions,
  listPublishedEntries,
  listRoles,
  publishContentType,
  publishEntry,
  unpublishEntry,
  updateAgentSchedule,
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
// TEST_PG_FETCH_TYPES=false runs with the Cloudflare edge target's driver
// options (postgres.js fetch_types off, as used behind Hyperdrive) to prove
// jsonb/array decoding doesn't depend on runtime pg_type discovery.
const URL = process.env.TEST_DATABASE_URL;
const storeOptions =
  process.env.TEST_PG_FETCH_TYPES === 'false' ? { max: 5, fetchTypes: false } : {};

const clock: Clock = { now: () => new Date('2026-01-01T00:00:00.000Z') };
const ids: IdGenerator = { newId: () => uuidv7() };

// 30s: the suite is opt-in and may target a remote database (e.g. a Neon
// branch), where per-query RTT makes the 5s default too tight.
describe.skipIf(!URL)('Postgres store (contract)', { timeout: 30_000 }, () => {
  let store: ReturnType<typeof createPostgresStore>;
  let ctx: AppContext;
  // Unique per run so repeated runs against the same database never collide.
  const spaceId = `t-${uuidv7()}`;
  const scope = { spaceId, environmentId: 'main' };

  beforeAll(async () => {
    store = createPostgresStore(URL as string, storeOptions);
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

  it('bulk publishes and unpublishes through the batched statements', async () => {
    const mk = (title: string) =>
      createEntry(ctx, scope, {
        contentTypeApiId: 'article',
        fields: { title: { 'en-US': title } },
      });
    const [a, b, c] = await Promise.all([mk('Bulk A'), mk('Bulk B'), mk('Bulk C')]);

    // Publish: exercises getMany, saveAggregateMany (multi-value upsert),
    // putPublishedMany, replaceForEntries, appendMany — plus a per-item
    // failure partitioned inside the committed batch.
    const summary = await bulkEntryAction(ctx, scope, 'publish', [
      a.entry.id,
      b.entry.id,
      c.entry.id,
      'missing-entry-id',
    ]);
    expect(summary.succeeded).toBe(3);
    expect(summary.failed).toBe(1);

    const published = await store.entries.getPublishedMany(scope, [
      a.entry.id,
      b.entry.id,
      c.entry.id,
    ]);
    expect(published).toHaveLength(3);
    // One shared publish instant across the chunk.
    expect(new Set(published.map((p) => p.publishedAt)).size).toBe(1);
    const drafts = await store.entries.getMany(scope, [a.entry.id, b.entry.id]);
    expect(drafts.every((d) => d.entry.status === 'published')).toBe(true);
    const events = await store.outbox.readPending(1000);
    const ourPublishes = events.filter(
      (ev) =>
        ev.type === 'entry.published' &&
        [a.entry.id, b.entry.id, c.entry.id].includes((ev as { entryId: string }).entryId),
    );
    expect(ourPublishes).toHaveLength(3);

    // Unpublish: exercises removePublishedMany + edge clearing.
    const undo = await bulkEntryAction(ctx, scope, 'unpublish', [a.entry.id, b.entry.id]);
    expect(undo.succeeded).toBe(2);
    expect(await store.entries.getPublishedMany(scope, [a.entry.id, b.entry.id])).toHaveLength(0);
    expect(await store.entries.getPublishedMany(scope, [c.entry.id])).toHaveLength(1);
  });

  it('round-trips the bulk-job repo (CAS claim, atomic counters, stall sweep)', async () => {
    const jobId = uuidv7();
    const now = clock.now();
    await store.bulkJobs.createJob(scope, {
      id: jobId,
      action: 'publish',
      status: 'running',
      totalItems: 3,
      totalChunks: 2,
      completedChunks: 0,
      succeeded: 0,
      failed: 0,
      createdAt: now.toISOString(),
    });
    await store.bulkJobs.createChunks(scope, [
      {
        jobId,
        chunkId: 'c00000',
        entryIds: ['a', 'b'],
        status: 'pending',
        attempts: 0,
        failures: [],
      },
      { jobId, chunkId: 'c00001', entryIds: ['c'], status: 'pending', attempts: 0, failures: [] },
    ]);

    // CAS claim: first wins, second (not stale) loses.
    const staleBefore = new Date(now.getTime() - 60_000);
    const claimed = await store.bulkJobs.claimChunk(scope, jobId, 'c00000', { now, staleBefore });
    expect(claimed?.attempts).toBe(1);
    expect(
      await store.bulkJobs.claimChunk(scope, jobId, 'c00000', { now, staleBefore }),
    ).toBeNull();
    // A stale claim IS re-claimable.
    const futureStale = new Date(now.getTime() + 60_000);
    const reclaimed = await store.bulkJobs.claimChunk(scope, jobId, 'c00000', {
      now,
      staleBefore: futureStale,
    });
    expect(reclaimed?.attempts).toBe(2);

    // The stall sweep sees the running-stale chunk and the aging pending one.
    // (Pending age uses the DB-stamped created_at — real time — while the
    // claim stamp came from the fixed test clock, so cut off after both.)
    const sweepCutoff = new Date(Date.now() + 60_000);
    const stalled = await store.bulkJobs.findStalledChunks(sweepCutoff, 1000);
    const ours = stalled.filter((s) => s.jobId === jobId);
    expect(ours.map((s) => s.chunkId).sort()).toEqual(['c00000', 'c00001']);

    // Complete folds counters atomically; a duplicate completion no-ops.
    const afterFirst = await store.bulkJobs.completeChunk(scope, jobId, 'c00000', {
      status: 'completed',
      succeeded: 2,
      failed: 0,
      failures: [],
    });
    expect(afterFirst).toMatchObject({ completedChunks: 1, succeeded: 2, failed: 0 });
    const dup = await store.bulkJobs.completeChunk(scope, jobId, 'c00000', {
      status: 'completed',
      succeeded: 2,
      failed: 0,
      failures: [],
    });
    expect(dup.completedChunks).toBe(1); // unchanged

    await store.bulkJobs.claimChunk(scope, jobId, 'c00001', { now, staleBefore });
    const afterSecond = await store.bulkJobs.completeChunk(scope, jobId, 'c00001', {
      status: 'failed',
      succeeded: 0,
      failed: 1,
      failures: [{ id: 'c', error: 'boom' }],
    });
    expect(afterSecond).toMatchObject({ completedChunks: 2, succeeded: 2, failed: 1 });

    // Finalize CAS: once, then null.
    expect(await store.bulkJobs.finalizeJob(scope, jobId, 'completed', now)).toBeTruthy();
    expect(await store.bulkJobs.finalizeJob(scope, jobId, 'completed', now)).toBeNull();
    const chunks = await store.bulkJobs.listChunks(scope, jobId);
    expect(chunks.find((c) => c.chunkId === 'c00001')?.failures).toEqual([
      { id: 'c', error: 'boom' },
    ]);
  });

  it('computes the reverse reference closure with one recursive query', async () => {
    // c <- b <- a  and  c <- d (direct): closure of [c] = {a, b, d}.
    const put = (fromEntryId: string, toId: string) =>
      store.references.replaceForEntry(scope, fromEntryId, [
        { fromEntryId, fromField: 'ref', toId, toType: 'Entry' },
      ]);
    await put('closure-b', 'closure-c');
    await put('closure-a', 'closure-b');
    await put('closure-d', 'closure-c');

    const closure = await store.references.findReverseClosure(scope, ['closure-c'], {
      maxDepth: 5,
      maxEntries: 100,
    });
    expect(closure.sort()).toEqual(['closure-a', 'closure-b', 'closure-d']);

    // Depth bound: depth 1 sees only direct embedders.
    const shallow = await store.references.findReverseClosure(scope, ['closure-c'], {
      maxDepth: 1,
      maxEntries: 100,
    });
    expect(shallow.sort()).toEqual(['closure-b', 'closure-d']);

    // Cycle safety: a <-> b terminates.
    await put('cyc-a', 'cyc-b');
    await put('cyc-b', 'cyc-a');
    const cyc = await store.references.findReverseClosure(scope, ['cyc-a'], {
      maxDepth: 10,
      maxEntries: 100,
    });
    expect(cyc).toEqual(['cyc-b']);
  });

  it('getPublishedMany returns present snapshots only, scoped', async () => {
    const otherScope = { spaceId: `t-${uuidv7()}`, environmentId: 'main' };
    await createSpace(ctx, {
      spaceId: otherScope.spaceId,
      name: 'Other',
      defaultLocale: 'en-US',
      locales: ['en-US'],
    });
    await createContentType(ctx, otherScope, {
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
      ],
    });
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Batch A' } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Batch B' } },
    });
    const foreign = await createEntry(ctx, otherScope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': 'Foreign' } },
    });
    await publishEntry(ctx, scope, a.entry.id);
    await publishEntry(ctx, scope, b.entry.id);
    await publishEntry(ctx, otherScope, foreign.entry.id);

    const got = await store.entries.getPublishedMany(scope, [
      a.entry.id,
      b.entry.id,
      foreign.entry.id, // other space — must not leak
      uuidv7(), // nonexistent — silently absent
    ]);
    expect(got.map((s) => s.entryId).sort()).toEqual([a.entry.id, b.entry.id].sort());
    expect(await store.entries.getPublishedMany(scope, [])).toEqual([]);
  });

  it('deleteRelayedBefore respects the limit and never deletes pending rows', async () => {
    const mk = (n: number) => ({
      id: uuidv7(),
      type: 'entry.published' as const,
      scope,
      occurredAt: clock.now().toISOString(),
      entryId: `sweep-${n}`,
      contentTypeApiId: 'article',
      version: 1,
      fields: {},
    });
    const [r1, r2, pending] = [mk(1), mk(2), mk(3)];
    await store.outbox.append(r1);
    await store.outbox.append(r2);
    await store.outbox.append(pending);
    await store.outbox.markRelayed([r1.id, r2.id]);

    const future = new Date(Date.now() + 60_000); // past the relay stamps
    expect(await store.outbox.deleteRelayedBefore(future, 1)).toBe(1);
    expect(await store.outbox.deleteRelayedBefore(future, 10)).toBe(1);
    expect(await store.outbox.deleteRelayedBefore(future, 10)).toBe(0);
    // The never-relayed row survived every sweep.
    const still = await store.outbox.readPending(1000);
    expect(still.some((ev) => ev.id === pending.id)).toBe(true);
  });

  it('deleteDeliveriesBefore trims old delivery records across spaces', async () => {
    const otherScope = { spaceId: `t-${uuidv7()}`, environmentId: 'main' };
    await store.webhooks.recordDelivery(scope, {
      webhookId: 'wh-sweep-a',
      eventId: 'evt-1',
      status: 'success',
      attempts: 1,
    });
    await store.webhooks.recordDelivery(otherScope, {
      webhookId: 'wh-sweep-b',
      eventId: 'evt-2',
      status: 'failed',
      attempts: 1,
    });

    // Platform sweep: both spaces' old records go; a future cutoff catches
    // the just-written rows (createdAt = DB now).
    const future = new Date(Date.now() + 60_000);
    const deleted = await store.webhooks.deleteDeliveriesBefore(future, 100);
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await store.webhooks.listDeliveries(scope, 'wh-sweep-a')).toEqual([]);
    expect(await store.webhooks.listDeliveries(otherScope, 'wh-sweep-b')).toEqual([]);
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

  it('round-trips the agent-schedules repo (incl. cross-scope findDue)', async () => {
    const created = await createAgentSchedule(ctx, scope, {
      workflow: 'enrich',
      cron: '0 2 * * *',
      contentTypeApiId: 'article',
    });
    const listed = await listAgentSchedules(ctx, scope);
    expect(listed.map((s) => s.id)).toContain(created.id);

    const updated = await updateAgentSchedule(ctx, scope, created.id, {
      cron: '30 4 * * *',
      autoApply: true,
    });
    expect(updated.autoApply).toBe(true);
    expect(updated.nextRunAt).toBe('2026-01-01T04:30:00.000Z');

    // Due scan crosses scopes and respects the enabled flag.
    const due = await store.agentSchedules.findDue('2026-01-02T00:00:00.000Z');
    expect(due.some((d) => d.schedule.id === created.id && d.scope.spaceId === spaceId)).toBe(true);

    // Optimistic claim: first CAS wins, the stale retry loses; run-state saves
    // only the cursor (cron/enabled untouched).
    const won = await store.agentSchedules.claimNextRun(
      scope,
      created.id,
      updated.nextRunAt,
      '2026-01-02T04:30:00.000Z',
    );
    expect(won).toBe(true);
    const lost = await store.agentSchedules.claimNextRun(
      scope,
      created.id,
      updated.nextRunAt,
      '2026-01-03T04:30:00.000Z',
    );
    expect(lost).toBe(false);
    await store.agentSchedules.saveRunState(scope, created.id, {
      lastRunAt: '2026-01-02T04:30:00.000Z',
      cursorEntryId: 'entry-cursor',
    });
    const afterRun = await store.agentSchedules.get(scope, created.id);
    expect(afterRun?.cursorEntryId).toBe('entry-cursor');
    expect(afterRun?.cron).toBe('30 4 * * *');
    await updateAgentSchedule(ctx, scope, created.id, { enabled: false });
    const dueAfterDisable = await store.agentSchedules.findDue('2026-01-02T00:00:00.000Z');
    expect(dueAfterDisable.some((d) => d.schedule.id === created.id)).toBe(false);

    await deleteAgentSchedule(ctx, scope, created.id);
    expect((await listAgentSchedules(ctx, scope)).map((s) => s.id)).not.toContain(created.id);
  });

  it('round-trips the agent-reviews repo (CAS decide/arm/apply)', async () => {
    const review = await createAgentReview(ctx, scope, {
      workflow: 'enrich',
      entryId: 'entry-x',
      proposed: { summary: { 'en-US': 'proposed' } },
      notes: ['note one'],
    });
    const [pending] = await store.agentReviews.list(scope, { status: 'pending' });
    expect(pending?.id).toBe(review.id);
    expect(pending?.proposed.summary?.['en-US']).toBe('proposed');

    // Arm is a CAS: first caller arms, a second observes.
    expect(await store.agentReviews.markAwaiting(scope, review.id)).toBe('armed');
    expect(await store.agentReviews.markAwaiting(scope, review.id)).toBe('pending');
    await store.agentReviews.clearAwaiting(scope, review.id);

    // Decide is a CAS: the second decision loses.
    expect(
      await store.agentReviews.decide(scope, review.id, {
        status: 'approved',
        decidedAt: '2026-01-02T00:00:00.000Z',
        decidedBy: 'contract-test',
      }),
    ).toBe(true);
    expect(
      await store.agentReviews.decide(scope, review.id, {
        status: 'rejected',
        decidedAt: '2026-01-02T00:00:01.000Z',
      }),
    ).toBe(false);

    // Exactly-once apply marker.
    expect(await store.agentReviews.markApplied(scope, review.id, '2026-01-02T00:00:02.000Z')).toBe(
      true,
    );
    expect(await store.agentReviews.markApplied(scope, review.id, '2026-01-02T00:00:03.000Z')).toBe(
      false,
    );
    const decided = await store.agentReviews.get(scope, review.id);
    expect(decided?.status).toBe('approved');
    expect(decided?.decidedBy).toBe('contract-test');
    expect(decided?.appliedAt).toBe('2026-01-02T00:00:02.000Z');
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

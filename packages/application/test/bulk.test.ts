import { ValidationError } from '@cw/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  bulkCreateEntries,
  bulkEntryAction,
  createContentType,
  createEntry,
  createSpace,
  getPublishedEntry,
} from '../src/index.js';

const scope = { spaceId: 'blog', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx };
}

async function seed(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'post',
    name: 'Post',
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
}

describe('bulk entry actions', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('publishes many entries and reports per-item success', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const b = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'B' } },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [a.entry.id, b.entry.id]);
    expect(summary).toMatchObject({ action: 'publish', total: 2, succeeded: 2, failed: 0 });
    expect(await getPublishedEntry(ctx, scope, a.entry.id)).toBeTruthy();
  });

  it('captures per-item failures without aborting the batch', async () => {
    const a = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: { title: { 'en-US': 'A' } },
    });
    const summary = await bulkEntryAction(ctx, scope, 'publish', [a.entry.id, 'missing-id']);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results.find((r) => r.id === 'missing-id')?.ok).toBe(false);
  });

  it('rejects an empty or oversized batch', async () => {
    await expect(bulkEntryAction(ctx, scope, 'publish', [])).rejects.toThrow(ValidationError);
  });
});

describe('bulk create', () => {
  let ctx: AppContext;
  beforeEach(async () => {
    ({ ctx } = setup());
    await seed(ctx);
  });

  it('creates valid items and reports invalid ones', async () => {
    const summary = await bulkCreateEntries(ctx, scope, [
      { contentTypeApiId: 'post', fields: { title: { 'en-US': 'Ok' } } },
      { contentTypeApiId: 'post', fields: {} }, // missing required title
    ]);
    expect(summary.succeeded).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.results[1]?.id).toBe('#1');
  });
});

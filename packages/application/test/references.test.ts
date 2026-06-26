import { ValidationError } from '@cw/domain';
import { FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  createContentType,
  createEntry,
  createSpace,
  getPublishedEntry,
  getReverseReferences,
  publishEntry,
  unpublishEntry,
} from '../src/index.js';

const scope = { spaceId: 'blog', environmentId: 'main' };

function makeContext() {
  const store = new InMemoryContentStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('e') };
  return { ctx, store };
}

async function seedModel(ctx: AppContext) {
  await createSpace(ctx, { spaceId: 'blog', name: 'Blog', defaultLocale: 'en-US' });
  await createContentType(ctx, scope, {
    apiId: 'author',
    name: 'Author',
    displayField: 'name',
    fields: [
      {
        apiId: 'name',
        name: 'Name',
        type: 'Symbol',
        localized: false,
        required: true,
        position: 0,
      },
    ],
  });
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
      {
        apiId: 'author',
        name: 'Author',
        type: 'Link',
        localized: false,
        required: false,
        position: 1,
        linkType: 'Entry',
      },
    ],
  });
}

describe('P3: references + link resolution', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ({ ctx } = makeContext());
  });

  it('materializes edges on publish and resolves them with ?include', async () => {
    await seedModel(ctx);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: { name: { 'en-US': 'Ada' } },
    });
    await publishEntry(ctx, scope, author.entry.id);

    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Hello' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);

    // Without include: the link is a stub.
    const flat = await getPublishedEntry(ctx, scope, post.entry.id, { locale: 'en-US' });
    expect(flat.fields.author).toEqual({ id: author.entry.id, linkType: 'Entry' });

    // With include=1: the author entry is embedded.
    const resolved = await getPublishedEntry(ctx, scope, post.entry.id, {
      locale: 'en-US',
      include: 1,
    });
    const embedded = resolved.fields.author as { id: string; fields: Record<string, unknown> };
    expect(embedded.id).toBe(author.entry.id);
    expect(embedded.fields.name).toBe('Ada');

    // Reverse lookup: the post links to the author.
    const reverse = await getReverseReferences(ctx, scope, author.entry.id);
    expect(reverse).toHaveLength(1);
    expect(reverse[0]?.fromEntryId).toBe(post.entry.id);
  });

  it('refuses to publish an entry that links to a nonexistent entry', async () => {
    await seedModel(ctx);
    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Orphan' },
        author: { 'en-US': { id: 'does-not-exist', linkType: 'Entry' } },
      },
    });
    await expect(publishEntry(ctx, scope, post.entry.id)).rejects.toBeInstanceOf(ValidationError);
  });

  it('clears edges on unpublish', async () => {
    await seedModel(ctx);
    const author = await createEntry(ctx, scope, {
      contentTypeApiId: 'author',
      fields: { name: { 'en-US': 'Ada' } },
    });
    await publishEntry(ctx, scope, author.entry.id);
    const post = await createEntry(ctx, scope, {
      contentTypeApiId: 'post',
      fields: {
        title: { 'en-US': 'Hi' },
        author: { 'en-US': { id: author.entry.id, linkType: 'Entry' } },
      },
    });
    await publishEntry(ctx, scope, post.entry.id);
    expect(await getReverseReferences(ctx, scope, author.entry.id)).toHaveLength(1);

    await unpublishEntry(ctx, scope, post.entry.id);
    expect(await getReverseReferences(ctx, scope, author.entry.id)).toHaveLength(0);
  });
});

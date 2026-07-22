import {
  FixedClock,
  InMemoryContentStore,
  InMemoryVectorStore,
  LocalEmbeddingsProvider,
  SequenceIdGenerator,
} from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  type RagDeps,
  chunk,
  createContentType,
  createEntry,
  createSpace,
  extractTextByLocale,
  indexEntryEmbeddings,
  publishEntry,
  reindexEmbeddings,
  removeEntryEmbeddings,
  semanticSearch,
} from '../src/index.js';

const scope = { spaceId: 'kb', environmentId: 'main' };

describe('P7: RAG indexing + semantic search', () => {
  let deps: RagDeps;
  beforeEach(() => {
    deps = { embeddings: new LocalEmbeddingsProvider(512), vectors: new InMemoryVectorStore() };
  });

  it('extracts localized text and chunks long text', () => {
    const text = extractTextByLocale({ title: { 'en-US': 'Hello' }, body: { 'en-US': 'World' } });
    expect(text['en-US']).toContain('Hello');
    expect(text['en-US']).toContain('World');
    expect(chunk('a b c d e', 2)).toEqual(['a b', 'c d', 'e']);
  });

  it('extracts plain text from rich-text values per locale', () => {
    const body = {
      nodeType: 'document',
      content: [
        { nodeType: 'heading-1', content: [{ nodeType: 'text', value: 'Guide' }] },
        { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'Rich body text' }] },
      ],
    };
    const text = extractTextByLocale({
      title: { 'en-US': 'Hello' },
      body: { 'en-US': body, 'de-DE': body },
    });
    expect(text['en-US']).toContain('Guide');
    expect(text['en-US']).toContain('Rich body text');
    expect(text['de-DE']).toContain('Guide');
  });

  it('indexes an entry whose only text lives in a rich-text body', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e-rich',
      entryVersion: 1,
      fields: {
        body: {
          'en-US': {
            nodeType: 'document',
            content: [
              {
                nodeType: 'paragraph',
                content: [{ nodeType: 'text', value: 'Kubernetes orchestrates containers' }],
              },
            ],
          },
        },
      },
    });
    const hits = await semanticSearch(deps, scope, 'kubernetes containers', { topK: 2 });
    expect(hits[0]?.entryId).toBe('e-rich');
  });

  it('indexes entries and ranks the relevant one first', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e-postgres',
      entryVersion: 1,
      fields: {
        body: {
          'en-US': 'PostgreSQL is a relational database with strong SQL support and indexes',
        },
      },
    });
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e-coffee',
      entryVersion: 1,
      fields: {
        body: { 'en-US': 'Espresso is a brewing method for coffee using pressure and hot water' },
      },
    });

    const hits = await semanticSearch(deps, scope, 'database sql indexes', { topK: 2 });
    expect(hits[0]?.entryId).toBe('e-postgres');
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  });

  it('replaces stale vectors on re-index (republish)', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e1',
      entryVersion: 1,
      fields: { body: { 'en-US': 'aardvark anteater' } },
    });
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e1',
      entryVersion: 2,
      fields: { body: { 'en-US': 'zebra zeppelin' } },
    });
    // Old terms no longer match; new terms do.
    expect((await semanticSearch(deps, scope, 'aardvark', { topK: 5 })).length).toBe(0);
    expect((await semanticSearch(deps, scope, 'zebra', { topK: 5 }))[0]?.entryId).toBe('e1');
  });

  it('removes embeddings on unpublish', async () => {
    await indexEntryEmbeddings(deps, scope, {
      entryId: 'e1',
      entryVersion: 1,
      fields: { body: { 'en-US': 'searchable content here' } },
    });
    await removeEntryEmbeddings(deps, scope, 'e1');
    expect((await semanticSearch(deps, scope, 'searchable', { topK: 5 })).length).toBe(0);
  });
});

describe('reindex embeddings', () => {
  let ctx: AppContext;
  let deps: RagDeps;

  beforeEach(async () => {
    ctx = {
      store: new InMemoryContentStore(),
      clock: new FixedClock(),
      ids: new SequenceIdGenerator('e'),
    };
    deps = { embeddings: new LocalEmbeddingsProvider(512), vectors: new InMemoryVectorStore() };
    for (const spaceId of ['kb', 'other']) {
      await createSpace(ctx, { spaceId, name: spaceId, defaultLocale: 'en-US' });
      await createContentType(
        ctx,
        { spaceId, environmentId: 'main' },
        {
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
        },
      );
    }
  });

  async function publishArticle(scope: { spaceId: string; environmentId: string }, title: string) {
    const { entry } = await createEntry(ctx, scope, {
      contentTypeApiId: 'article',
      fields: { title: { 'en-US': title } },
    });
    await publishEntry(ctx, scope, entry.id);
    return entry.id;
  }

  it('embeds all published entries so they become searchable', async () => {
    const pg = await publishArticle(scope, 'PostgreSQL relational database indexes');
    await publishArticle(scope, 'Espresso brewing methods for coffee');

    // Nothing indexed yet — publish alone does not embed in this harness.
    expect((await semanticSearch(deps, scope, 'database', { topK: 5 })).length).toBe(0);

    const result = await reindexEmbeddings(deps, ctx, scope, { batchSize: 1 });
    expect(result.entries).toBe(2);
    expect(result.chunks).toBeGreaterThanOrEqual(2);

    const hits = await semanticSearch(deps, scope, 'relational database', { topK: 5 });
    expect(hits[0]?.entryId).toBe(pg);
  });

  it('returns zero counts for a scope with nothing published', async () => {
    expect(await reindexEmbeddings(deps, ctx, scope, {})).toEqual({
      entries: 0,
      chunks: 0,
      truncated: false,
    });
  });

  it('enforces a cooldown between reindex runs when a cache is present', async () => {
    const entries = new Map<string, string>();
    const cache = {
      get: async (k: string) => entries.get(k) ?? null,
      set: async (k: string, v: string) => void entries.set(k, v),
      invalidateTag: async () => {},
    };
    const guarded: AppContext = { ...ctx, cache };
    await publishArticle(scope, 'postgres relational database');
    // First run succeeds and sets the cooldown.
    await expect(reindexEmbeddings(deps, guarded, scope, {})).resolves.toBeTruthy();
    // Second run within the window is rejected.
    await expect(reindexEmbeddings(deps, guarded, scope, {})).rejects.toThrow(/cooldown/i);
  });

  it('only touches the requested scope', async () => {
    const otherScope = { spaceId: 'other', environmentId: 'main' };
    await publishArticle(scope, 'kubernetes container orchestration');
    await publishArticle(otherScope, 'terraform infrastructure as code');

    const result = await reindexEmbeddings(deps, ctx, scope, {});
    expect(result.entries).toBe(1);

    expect((await semanticSearch(deps, scope, 'kubernetes', { topK: 5 })).length).toBe(1);
    expect((await semanticSearch(deps, otherScope, 'terraform', { topK: 5 })).length).toBe(0);
  });
});

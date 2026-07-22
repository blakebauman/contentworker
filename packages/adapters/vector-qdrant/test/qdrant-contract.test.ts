import { describe, expect, it } from 'vitest';
import { createQdrantStore } from '../src/index.js';

// Opt-in contract suite: runs only against a real Qdrant.
//   docker run -p 6333:6333 qdrant/qdrant
//   TEST_QDRANT_URL=http://localhost:6333 pnpm --filter @cw/adapter-vector-qdrant test
const url = process.env.TEST_QDRANT_URL;

describe.skipIf(!url)('Qdrant contract (real instance)', () => {
  const collection = `cw_test_${Date.now()}`;
  const scope = { spaceId: 'contract', environmentId: 'main' };
  const otherScope = { spaceId: 'other', environmentId: 'main' };
  const vec = (a: number, b: number) => {
    const norm = Math.sqrt(a * a + b * b) || 1;
    return [a / norm, b / norm];
  };

  it('upserts, queries with scope isolation, replaces, and deletes', async () => {
    const store = createQdrantStore({ url, collection, dimensions: 2 });

    await store.upsert([
      {
        scope,
        entryId: 'e1',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'alpha',
        embedding: vec(1, 0),
        entryVersion: 1,
      },
      {
        scope,
        entryId: 'e1',
        locale: 'en-US',
        chunkIndex: 1,
        chunkText: 'beta',
        embedding: vec(0.9, 0.1),
        entryVersion: 1,
      },
      {
        scope,
        entryId: 'e2',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'gamma',
        embedding: vec(0, 1),
        entryVersion: 1,
      },
    ]);
    await store.upsert([
      {
        scope: otherScope,
        entryId: 'x1',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'foreign',
        embedding: vec(1, 0),
        entryVersion: 1,
      },
    ]);

    // Nearest to [1,0] within scope: e1 chunks, never the other tenant's x1.
    const near = await store.query(scope, vec(1, 0), { topK: 10 });
    expect(near[0]?.entryId).toBe('e1');
    expect(near.every((m) => m.entryId !== 'x1')).toBe(true);

    // Replace = deleteByEntry + upsert (the indexEntryEmbeddings contract;
    // upsert alone is not a replace, matching the pgvector adapter).
    await store.deleteByEntry(scope, 'e1');
    await store.upsert([
      {
        scope,
        entryId: 'e1',
        locale: 'en-US',
        chunkIndex: 0,
        chunkText: 'alpha v2',
        embedding: vec(1, 0),
        entryVersion: 2,
      },
    ]);
    const afterReplace = await store.query(scope, vec(1, 0), { topK: 10 });
    const e1Chunks = afterReplace.filter((m) => m.entryId === 'e1');
    expect(e1Chunks).toHaveLength(1);
    expect(e1Chunks[0]?.chunkText).toBe('alpha v2');

    // minScore filters orthogonal matches.
    const filtered = await store.query(scope, vec(1, 0), { topK: 10, minScore: 0.5 });
    expect(filtered.every((m) => m.score >= 0.5)).toBe(true);

    // deleteByEntry removes exactly that entry's vectors.
    await store.deleteByEntry(scope, 'e1');
    const afterDelete = await store.query(scope, vec(1, 0), { topK: 10 });
    expect(afterDelete.every((m) => m.entryId !== 'e1')).toBe(true);
    expect(afterDelete.some((m) => m.entryId === 'e2')).toBe(true);
  });
});

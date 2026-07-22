import { describe, expect, it } from 'vitest';
import { createOpenSearchIndex } from '../src/index.js';

// Opt-in contract suite: runs only against a real OpenSearch.
//   docker run -p 9200:9200 -e discovery.type=single-node \
//     -e DISABLE_SECURITY_PLUGIN=true opensearchproject/opensearch:2
//   TEST_OPENSEARCH_URL=http://localhost:9200 pnpm --filter @cw/adapter-search-opensearch test
const url = process.env.TEST_OPENSEARCH_URL;

describe.skipIf(!url)('OpenSearch contract (real instance)', () => {
  const index = `cw-test-${Date.now()}`;
  const scope = { spaceId: 'contract', environmentId: 'main' };
  const otherScope = { spaceId: 'other', environmentId: 'main' };

  it('indexes, searches with AND semantics and scope isolation, and removes', async () => {
    const search = createOpenSearchIndex({ url, index });

    await search.index(scope, {
      entryId: 'e1',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'PostgreSQL relational database indexes' },
      entryVersion: 1,
    });
    await search.index(scope, {
      entryId: 'e2',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'Espresso brewing methods for coffee' },
      entryVersion: 1,
    });
    await search.index(otherScope, {
      entryId: 'x1',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'PostgreSQL in another tenant' },
      entryVersion: 1,
    });

    // Single term: only the matching entry, never the other tenant's.
    const one = await search.search(scope, 'postgresql', { topK: 10 });
    expect(one.map((h) => h.entryId)).toEqual(['e1']);

    // AND semantics: both terms must match one document.
    expect(await search.search(scope, 'postgresql coffee', { topK: 10 })).toHaveLength(0);
    expect(await search.search(scope, 'relational indexes', { topK: 10 })).toHaveLength(1);

    // Re-index replaces the document (same id).
    await search.index(scope, {
      entryId: 'e1',
      contentTypeApiId: 'article',
      textByLocale: { 'en-US': 'Now about sailing instead' },
      entryVersion: 2,
    });
    expect(await search.search(scope, 'postgresql', { topK: 10 })).toHaveLength(0);
    expect((await search.search(scope, 'sailing', { topK: 10 })).map((h) => h.entryId)).toEqual([
      'e1',
    ]);

    // Remove is idempotent and effective.
    await search.remove(scope, 'e1');
    await search.remove(scope, 'e1');
    expect(await search.search(scope, 'sailing', { topK: 10 })).toHaveLength(0);
  });
});

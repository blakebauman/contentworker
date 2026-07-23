/**
 * Read-path benchmark for the Delivery API — the launch-critical surface.
 *
 * Traffic mix (weights in DEFAULT_MIX): entry lists with content-type
 * rotation and pagination, filtered/ordered/selected lists exercising the
 * query grammar, single entries with reference resolution, assets, GraphQL
 * collections, and full-text `query=` search. `SEARCH=true` adds hybrid
 * semantic search (needs a real embeddings/vector adapter to mean anything).
 *
 *   pnpm --filter @cw/bench delivery
 *   k6 run -e PROFILE=baseline -e RATE=100 packages/bench/k6/delivery.ts
 *   k6 run -e PROFILE=stress -e BASE_URL=https://staging.example.com packages/bench/k6/delivery.ts
 *
 * Seed the target first (SEED_DEV=true, SEED_SCALE for volume) so the pools
 * below have material — see docs/benchmarking.md.
 */
import { check } from 'k6';
import http from 'k6/http';
import type { Options } from 'k6/options';
import {
  DELIVERY,
  LOCALE,
  P95_MS,
  PROFILE,
  WITH_SEARCH,
  type WeightedBranch,
  cdaHeaders,
  mix,
  scenarioFor,
} from './config.ts';

export const options: Options = {
  scenarios: scenarioFor(PROFILE, 'browse'),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: [`p(95)<${P95_MS}`],
    // Single-entry reads are the cheapest op — hold them to half the budget.
    'http_req_duration{name:entry-by-id}': [`p(95)<${Math.ceil(P95_MS / 2)}`],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

interface Pools {
  entryIds: string[];
  assetIds: string[];
}

const CONTENT_TYPES = ['article', 'product', 'event', 'recipe', 'page'] as const;

const FILTER_VARIANTS = [
  'content_type=article&fields.featured[eq]=true&limit=20',
  'content_type=article&fields.views[gte]=10000&order=-fields.views&limit=20',
  'content_type=article&fields.category[exists]=false&limit=20',
  'content_type=article&order=-fields.publishedDate&select=fields.title,fields.summary&limit=20',
  'content_type=product&fields.availability[in]=in-stock,backorder&limit=20',
  'content_type=event&order=fields.startDate&limit=20',
  'content_type=article&query=localization&limit=10',
] as const;

const SEARCH_TERMS = [
  'localization',
  'edge delivery',
  'agent workflows',
  'cache invalidation',
] as const;

/** Builds id pools from real published content so reads hit real documents. */
export function setup(): Pools {
  const pools: Pools = { entryIds: [], assetIds: [] };
  for (const ct of ['article', 'product']) {
    const res = http.get(`${DELIVERY}/entries?content_type=${ct}&limit=100`, {
      headers: cdaHeaders,
    });
    if (res.status !== 200) {
      throw new Error(`setup: listing ${ct} failed with ${res.status} — is the target seeded?`);
    }
    for (const item of res.json('items') as { id: string }[]) pools.entryIds.push(item.id);
  }
  const assets = http.get(`${DELIVERY}/assets?limit=50`, { headers: cdaHeaders });
  if (assets.status === 200) {
    // Published asset snapshots key on `assetId` (not `id` like entries).
    for (const item of assets.json('items') as { assetId: string }[]) {
      pools.assetIds.push(item.assetId);
    }
  }
  if (pools.entryIds.length === 0) {
    throw new Error('setup: no published entries — seed the target (SEED_DEV=true) first');
  }
  return pools;
}

const DEFAULT_MIX: readonly WeightedBranch[] = [
  ['list', 30],
  ['filtered', 20],
  ['byId', 25],
  ['assets', 10],
  ['graphql', 10],
  ['search', WITH_SEARCH ? 5 : 0],
];

export function browse(pools: Pools): void {
  const seed = __VU * 100_000 + __ITER;
  const branch = mix(seed, DEFAULT_MIX);

  if (branch === 'list') {
    const ct = CONTENT_TYPES[seed % CONTENT_TYPES.length]!;
    // Rotate through the first 10 pages so pagination depth is exercised.
    const skip = (seed % 10) * 20;
    const res = http.get(
      `${DELIVERY}/entries?content_type=${ct}&limit=20&skip=${skip}&locale=${LOCALE}`,
      { headers: cdaHeaders, tags: { name: 'list' } },
    );
    check(res, {
      'list 200': (r) => r.status === 200,
      'list has items': (r) => Array.isArray(r.json('items')),
    });
    return;
  }

  if (branch === 'filtered') {
    const qs = FILTER_VARIANTS[seed % FILTER_VARIANTS.length]!;
    const res = http.get(`${DELIVERY}/entries?${qs}`, {
      headers: cdaHeaders,
      tags: { name: 'filtered-list' },
    });
    check(res, { 'filtered 200': (r) => r.status === 200 });
    return;
  }

  if (branch === 'byId') {
    const id = pools.entryIds[seed % pools.entryIds.length]!;
    // Half the reads resolve references two levels deep — the expensive path.
    const include = seed % 2 === 0 ? '?include=2' : '';
    const res = http.get(`${DELIVERY}/entries/${id}${include}`, {
      headers: cdaHeaders,
      tags: { name: 'entry-by-id' },
    });
    check(res, { 'entry 200': (r) => r.status === 200 });
    return;
  }

  if (branch === 'assets') {
    const target =
      pools.assetIds.length > 0 && seed % 2 === 0
        ? `${DELIVERY}/assets/${pools.assetIds[seed % pools.assetIds.length]}`
        : `${DELIVERY}/assets?limit=20`;
    const res = http.get(target, { headers: cdaHeaders, tags: { name: 'assets' } });
    check(res, { 'assets 200': (r) => r.status === 200 });
    return;
  }

  if (branch === 'graphql') {
    const skip = (seed % 5) * 10;
    const res = http.post(
      `${DELIVERY}/graphql`,
      JSON.stringify({
        // locale is required to unwrap localized values into plain scalars.
        query: `{ articleCollection(limit: 10, skip: ${skip}, locale: "${LOCALE}", order: ["-fields.publishedDate"]) { _sys { id } title summary readingTime } }`,
      }),
      {
        headers: { ...cdaHeaders, 'content-type': 'application/json' },
        tags: { name: 'graphql' },
      },
    );
    check(res, {
      'graphql 200': (r) => r.status === 200,
      'graphql no errors': (r) => r.json('errors') === undefined,
    });
    return;
  }

  // branch === 'search' (only reachable when SEARCH=true)
  const q = SEARCH_TERMS[seed % SEARCH_TERMS.length]!;
  const res = http.get(`${DELIVERY}/search?q=${encodeURIComponent(q)}&mode=hybrid&top_k=10`, {
    headers: cdaHeaders,
    tags: { name: 'search' },
  });
  check(res, { 'search 200': (r) => r.status === 200 });
}

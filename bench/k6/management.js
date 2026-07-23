/**
 * Write-path benchmark for the Management API: draft → update → publish →
 * unpublish, the full entry lifecycle including the transactional-outbox
 * write on publish.
 *
 * MUTATES THE TARGET. Every entry it creates is titled "bench …" — run it
 * against a disposable stack (in-memory dev, or a docker-compose Postgres you
 * plan to throw away), never against an environment you care about.
 *
 *   k6 run bench/k6/management.js                       # smoke: 2 VUs, 30s
 *   k6 run -e PROFILE=baseline -e RATE=10 bench/k6/management.js
 *
 * Writes are held to a laxer p95 than reads (WRITE_P95_MS, default 800):
 * publish does validation + referential-integrity checks + a read-model
 * snapshot + an outbox append in one transaction.
 */
import { check } from 'k6';
import http from 'k6/http';
import { LOCALE, MGMT, PROFILE, cmaHeaders, mix, scenarioFor } from './config.js';

const WRITE_P95 = Number(__ENV.WRITE_P95_MS ?? 800);

export const options = {
  scenarios: scenarioFor(PROFILE, 'lifecycle'),
  thresholds: {
    http_req_failed: ['rate<0.01'],
    http_req_duration: [`p(95)<${WRITE_P95}`],
    'http_req_duration{name:publish}': [`p(95)<${WRITE_P95}`],
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

export function setup() {
  const res = http.get(`${MGMT}/content-types`, { headers: cmaHeaders });
  if (res.status !== 200) {
    throw new Error(`setup: management auth failed with ${res.status}`);
  }
  const hasArticle = res.json('items').some((ct) => ct.apiId === 'article');
  if (!hasArticle) {
    throw new Error('setup: no "article" content type — seed the target (SEED_DEV=true) first');
  }
}

const loc = (value) => ({ [LOCALE]: value });

export function lifecycle() {
  const seed = __VU * 100_000 + __ITER;
  const title = `bench ${__VU}-${__ITER}`;

  const created = http.post(
    `${MGMT}/entries`,
    JSON.stringify({
      contentTypeApiId: 'article',
      fields: {
        title: loc(title),
        body: loc(`Benchmark write ${seed}: lifecycle entry, safe to delete.`),
        summary: loc('k6 write-path benchmark entry.'),
        views: loc(seed % 1000),
        featured: loc(false),
      },
    }),
    { headers: cmaHeaders, tags: { name: 'create' } },
  );
  const ok = check(created, { 'create 201': (r) => r.status === 201 });
  if (!ok) return;
  const id = created.json('entry.id');

  const branch = mix(seed, [
    ['publish', 50],
    ['updateThenPublish', 30],
    ['draftOnly', 20],
  ]);
  if (branch === 'draftOnly') return;

  if (branch === 'updateThenPublish') {
    const updated = http.put(
      `${MGMT}/entries/${id}`,
      JSON.stringify({
        fields: {
          title: loc(title),
          body: loc(`Benchmark write ${seed}: revised before publish.`),
          summary: loc('k6 write-path benchmark entry (v2).'),
          views: loc((seed % 1000) + 1),
          featured: loc(true),
        },
      }),
      { headers: cmaHeaders, tags: { name: 'update' } },
    );
    check(updated, { 'update 200': (r) => r.status === 200 });
  }

  const published = http.post(`${MGMT}/entries/${id}/published`, null, {
    headers: cmaHeaders,
    tags: { name: 'publish' },
  });
  check(published, { 'publish 200': (r) => r.status === 200 });

  // A slice of published entries is withdrawn again — exercises the
  // unpublish path and keeps the published set from growing monotonically.
  if (seed % 4 === 0) {
    const unpublished = http.del(`${MGMT}/entries/${id}/published`, null, {
      headers: cmaHeaders,
      tags: { name: 'unpublish' },
    });
    check(unpublished, { 'unpublish 200': (r) => r.status === 200 });
  }
}

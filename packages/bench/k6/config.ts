/**
 * Shared configuration for the k6 benchmarks. Everything is env-driven so the
 * same scripts run against a local in-memory API, docker-compose Postgres, a
 * K8s deployment, or the edge Worker:
 *
 *   BASE_URL   target origin                    (default http://localhost:8787)
 *   SPACE/ENV  content scope                    (default space-1/main)
 *   LOCALE     read locale                      (default en-US)
 *   CDA_TOKEN  delivery:read bearer             (default dev-cda-key)
 *   CMA_TOKEN  management bearer (writes)       (default dev-cma-key)
 *   PROFILE    smoke|baseline|stress|spike|soak (default smoke)
 *   P95_MS     read-path p95 threshold, ms      (default 300)
 *   RATE       arrival rate for constant profiles, req/s (profile default)
 *   DURATION   duration for constant profiles   (profile default)
 *   SEARCH     "true" adds hybrid-search traffic (default off — depends on a
 *              real embeddings/vector adapter to be meaningful)
 *
 * These scripts run under k6's runtime (not Node): only `k6/*` modules and
 * standard JS built-ins are available. k6 (≥ v0.57) executes the TypeScript
 * directly — no build step.
 */
import type { Scenario } from 'k6/options';

export const BASE_URL = __ENV.BASE_URL ?? 'http://localhost:8787';
export const SPACE = __ENV.SPACE ?? 'space-1';
export const ENVIRONMENT = __ENV.ENV ?? 'main';
export const LOCALE = __ENV.LOCALE ?? 'en-US';
export const CDA_TOKEN = __ENV.CDA_TOKEN ?? 'dev-cda-key';
export const CMA_TOKEN = __ENV.CMA_TOKEN ?? 'dev-cma-key';
export const P95_MS = Number(__ENV.P95_MS ?? 300);
export const WITH_SEARCH = __ENV.SEARCH === 'true';

export const DELIVERY = `${BASE_URL}/delivery/${SPACE}/${ENVIRONMENT}`;
export const MGMT = `${BASE_URL}/spaces/${SPACE}/environments/${ENVIRONMENT}`;

export const cdaHeaders: Record<string, string> = {
  authorization: `Bearer ${CDA_TOKEN}`,
};
export const cmaHeaders: Record<string, string> = {
  authorization: `Bearer ${CMA_TOKEN}`,
  'content-type': 'application/json',
};

export type WeightedBranch = readonly [name: string, weight: number];

/**
 * Deterministic per-iteration branch picker: keeps the traffic mix stable
 * across runs (no Math.random) so two runs at the same profile are comparable.
 */
export function mix(seed: number, weights: readonly WeightedBranch[]): string {
  const total = weights.reduce((a, [, w]) => a + w, 0);
  let n = ((seed * 2654435761) >>> 0) % total;
  for (const [name, w] of weights) {
    if (n < w) return name;
    n -= w;
  }
  return weights[0]![0];
}

/**
 * Scenario profiles. Arrival-rate executors (not looping VUs) for the load
 * profiles, so measured latency degradation cannot self-throttle the offered
 * load — the standard methodology for capacity benchmarks.
 */
export function scenarioFor(profile: string, execFn: string): Record<string, Scenario> {
  const rate = Number(__ENV.RATE ?? 0);
  const duration = __ENV.DURATION ?? '';
  const profiles: Record<string, Scenario> = {
    // Functional pulse: is the target up and are the requests correct?
    smoke: { executor: 'constant-vus', vus: 2, duration: duration || '30s' },
    // Steady state at a fixed offered load — the day-to-day comparison run.
    baseline: {
      executor: 'constant-arrival-rate',
      rate: rate || 50,
      timeUnit: '1s',
      duration: duration || '2m',
      preAllocatedVUs: 50,
      maxVUs: 200,
    },
    // Ramp until it hurts: find the knee of the latency curve.
    stress: {
      executor: 'ramping-arrival-rate',
      startRate: 10,
      timeUnit: '1s',
      preAllocatedVUs: 100,
      maxVUs: 500,
      stages: [
        { target: 50, duration: '1m' },
        { target: 150, duration: '2m' },
        { target: 300, duration: '3m' },
        { target: 300, duration: '1m' },
        { target: 0, duration: '30s' },
      ],
    },
    // Sudden burst: cold caches, connection churn, queue behavior.
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { target: 150, duration: '20s' },
        { target: 150, duration: '1m' },
        { target: 0, duration: '20s' },
      ],
    },
    // Long steady load: leaks, pool exhaustion, GC drift.
    soak: {
      executor: 'constant-arrival-rate',
      rate: rate || 30,
      timeUnit: '1s',
      duration: duration || '30m',
      preAllocatedVUs: 60,
      maxVUs: 200,
    },
  };
  const selected = profiles[profile] ?? profiles.smoke!;
  return { [profile]: { ...selected, exec: execFn } };
}

export const PROFILE = __ENV.PROFILE ?? 'smoke';

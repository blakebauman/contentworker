# @cw/bench — k6 benchmarks

Load tests for the two API surfaces that matter at launch. The scripts are
TypeScript run **directly by k6** (≥ v0.57) — no build step — and typechecked
against `@types/k6` in CI like any other workspace package.

| Script | Surface | Mutates target? |
| --- | --- | --- |
| `k6/delivery.ts` | Delivery API reads: lists + pagination, filter grammar, single entries with `include`, assets, GraphQL, full-text search, optional hybrid search | No |
| `k6/management.ts` | Entry lifecycle writes: create → update → publish (transactional outbox) → unpublish | **Yes — disposable stacks only** |

## Prerequisites

- [k6](https://k6.io/docs/get-started/installation/) (`brew install k6`), or Docker (`grafana/k6` image)
- A **seeded** target: boot with `SEED_DEV=true` (the `pnpm --filter @cw/api dev` script sets it) and pick a volume with `SEED_SCALE` — see `docs/benchmarking.md`

## Quick start

```bash
# Terminal 1: seeded target (in-memory; use docker compose for Postgres)
SEED_SCALE=10 pnpm --filter @cw/api dev

# Terminal 2: smoke, then a real baseline
pnpm --filter @cw/bench delivery
k6 run -e PROFILE=baseline -e RATE=100 packages/bench/k6/delivery.ts
```

Via Docker (no local k6):

```bash
docker run --rm -i -v "$PWD/packages/bench/k6:/bench" grafana/k6 run \
  -e BASE_URL=http://host.docker.internal:8787 -e PROFILE=baseline /bench/delivery.ts
```

## Profiles

| `PROFILE` | Shape | Purpose |
| --- | --- | --- |
| `smoke` (default) | 2 VUs, 30s | Are the requests correct against this target? |
| `baseline` | constant `RATE` req/s (default 50) for `DURATION` (default 2m) | The comparable steady-state number |
| `stress` | ramp 10→300 req/s over ~7m | Find the knee of the latency curve |
| `spike` | 0→150 VUs in 20s, hold 1m | Cold caches, connection churn |
| `soak` | constant 30 req/s for 30m | Leaks, pool exhaustion, drift |

Load profiles use **arrival-rate executors**, so offered load stays fixed as
latency degrades (looping VUs would self-throttle and flatter the results).

## Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:8787` | Target origin |
| `SPACE` / `ENV` | `space-1` / `main` | Content scope |
| `LOCALE` | `en-US` | Read locale |
| `CDA_TOKEN` / `CMA_TOKEN` | dev keys | Bearer tokens |
| `PROFILE` | `smoke` | See above |
| `RATE` / `DURATION` | per profile | Override constant-profile load |
| `P95_MS` | `300` | Read-path p95 threshold (fails the run when exceeded) |
| `WRITE_P95_MS` | `800` | Write-path p95 threshold (`management.ts`) |
| `SEARCH` | off | `true` adds hybrid-search traffic (needs real embeddings/vector adapters) |

## Reading the results

Thresholds fail the run (non-zero exit) when breached: error rate ≥ 1%,
read p95 over `P95_MS`, single-entry p95 over half of it. Per-route timings are
tagged — `http_req_duration{name:entry-by-id}`, `{name:list}`,
`{name:filtered-list}`, `{name:graphql}`, `{name:publish}` — so a regression
points at a route, not just a global average. The traffic mix is deterministic
(no `Math.random`), so two runs at the same profile and scale are comparable.

## Package layout note

This package intentionally has no `test` script and no runtime dependencies:
k6 is an external binary, the scripts never import workspace packages (they
exercise the platform over HTTP like any real client), and `typecheck` is the
only CI-relevant target.

# Benchmarking

How to measure content-at-scale performance before launch: seed a realistic
corpus with `@cw/seed`, then drive load with the k6 suite in
[`@cw/bench`](../packages/bench/README.md).

## 1. Seed the target at scale

The dev seed is deterministic and scales linearly via `SEED_SCALE`
(see [configuration](./configuration.md#demo-dataset-seed_dev-seed_scale)):

| `SEED_SCALE` | Entries (approx) | Use |
| --- | --- | --- |
| `1` | ~550 | Demos, functional smoke |
| `10` | ~4.5k | Pagination and filter realism |
| `100` | ~44k | Pre-launch capacity benchmarks |

**In-memory** (quick loops, no I/O realism):

```bash
SEED_SCALE=10 pnpm --filter @cw/api dev
```

**Postgres via docker-compose** (the representative setup — real query plans,
connection pools, and the transactional outbox):

```bash
# docker-compose.yml already sets SEED_DEV=true and passes SEED_SCALE through
SEED_SCALE=100 docker compose up --build
```

Seeding is idempotent: the corpus is written once (marked by a `demo-seed-v3`
tag) and later boots short-circuit, so restarting the stack does not re-pay
the seeding cost. Postgres keeps the data across restarts.

## 2. Run the load

```bash
pnpm --filter @cw/bench delivery                                        # smoke first
k6 run -e PROFILE=baseline -e RATE=100 packages/bench/k6/delivery.ts    # steady state
k6 run -e PROFILE=stress packages/bench/k6/delivery.ts                  # find the knee
k6 run -e PROFILE=baseline -e RATE=10 packages/bench/k6/management.ts   # write path
```

`delivery.ts` is read-only. `management.ts` **writes** (bench-titled entries)
— point it only at disposable stacks. Profiles, env vars, and thresholds are
documented in [`packages/bench/README.md`](../packages/bench/README.md).

## 3. What to compare

- **Baseline p95 per route** — the tagged timings (`entry-by-id`, `list`,
  `filtered-list`, `graphql`, `publish`) across `SEED_SCALE=1` vs `10` vs
  `100`: flat means indexed access paths; growing means a scan is hiding
  somewhere.
- **The stress knee** — the arrival rate where p95 leaves the plateau. That,
  minus headroom, is the per-replica capacity number for sizing.
- **Soak drift** — p95 at minute 25 vs minute 5 at constant load; growth
  suggests leaks or pool exhaustion.
- **Error budget** — thresholds fail the run at ≥1% errors, so CI-style
  gating is a matter of running k6 with `--quiet` and checking the exit code.

Benchmarks are not part of `pnpm test` or CI — they are run deliberately,
against a target you control, with the load profile in the command line.

## Cheap wins to check first when numbers disappoint

- Postgres: `EXPLAIN ANALYZE` the delivery list query with your filter — the
  denormalized published read model should be index-only for `content_type` +
  `order` paths.
- `include=2` reads fan out reference resolution; compare `include=0` vs `2`
  to separate document fetch cost from graph resolution cost.
- The edge Worker path (Hyperdrive/Neon) has different latency characteristics
  than the Node API — benchmark the deployment shape you will actually ship.

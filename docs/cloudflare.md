# Cloudflare deployment (`apps/edge`)

contentworker's second deployment target: one Cloudflare Worker runs the entire
platform — Management/Delivery/Preview APIs, the admin SPA, the MCP server, the
event pipeline, the Live Content API, and the durable agents — against **Neon
Postgres via Hyperdrive**. (Enterprises that need blast-radius isolation can
split the same script into three role-isolated workers — see
[Deployment topologies](#deployment-topologies-one-worker-or-three).) The
Node + Kubernetes/compose path (see [deployment.md](deployment.md)) remains
fully supported for self-hosting; both targets share the same hexagonal core
and differ only in adapters and composition roots.

## How the pieces map

| Node path | Cloudflare path |
| --- | --- |
| `apps/api` (Hono on node-server) | `fetch` handler in `apps/edge` (same `createApp`) |
| `apps/worker` BullMQ consumer | `queue()` handler on the `cw-events` queue (same `consumeEvent`) |
| Outbox relay loop (1s `setInterval`) | Post-commit `waitUntil` nudge after every mutating request + 1-minute cron sweeper |
| Scheduled-actions loop (5s) | The same cron sweeper (≤60s worst-case skew) |
| `apps/mcp-server` (`node:http`) | `POST /mcp` via `@hono/mcp` (same `buildServer`) |
| Postgres (`DATABASE_URL`) | Neon via the `HYPERDRIVE` binding (same Drizzle store, `fetch_types` off) |
| Redis cache | `KV_CACHE` (tag-versioned; see staleness note below) |
| Redis pub/sub → in-process SSE | `LiveHubDO` Durable Object per space:environment serves the SSE stream |
| pgvector | `VECTORIZE` index (hybrid search's FTS leg stays in Neon; RRF fusion is app code) |
| S3/MinIO blob | R2 via its S3 API (same `@cw/adapter-blob-s3`, presigned URLs) |
| Temporal agent runtime | `AGENT_WF` Cloudflare Workflow (`AGENT_RUNTIME=cloudflare-workflows`) |
| In-process auth rate limiter | `AUTH_LIMITER` Durable Object per client IP — the failure budget is global across isolates/colos (same `AUTH_RATE_LIMIT_*` vars) |
| Prometheus metrics (worker `/metrics`) | `METRICS` Workers Analytics Engine dataset — same `cw_*` metric names (`cw_outbox_relayed_total`, `cw_relay_errors_total`, `cw_events_consumed_total`, `cw_scheduled_actions_total`, plus edge-only `cw_agent_jobs_total`, `cw_dead_letters_total`). Unbound → each increment falls back to a structured JSON log line in Workers Logs |
| Admin SPA (static hosting) | Same Worker, `assets` binding (same-origin, no CORS) |

Every env var keeps its Node-path name ([configuration.md](configuration.md));
bindings replace URLs where a Cloudflare-native resource exists. Absent
bindings degrade exactly like the Node path (in-memory store, fake blob, stub
AI), so `wrangler dev -e demo` boots a zero-infrastructure demo.

## Provisioning

```bash
# one-time resources
wrangler hyperdrive create cw-neon --connection-string="$NEON_UNPOOLED_URL"
wrangler kv namespace create cw-cache
wrangler vectorize create cw-vectors --dimensions=1536 --metric=cosine
wrangler queues create cw-events && wrangler queues create cw-agents && wrangler queues create cw-events-dlq
wrangler r2 bucket create cw-assets    # + an R2 S3-API token for presigning

# paste the hyperdrive/kv ids into apps/edge/wrangler.jsonc, then
wrangler secret put ADMIN_TOKEN         # + MCP_TOKEN, TOKEN_PEPPER, SESSION_SECRET,
                                        #   ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID/SECRET (R2)
pnpm --filter @cw/admin build
pnpm --filter @cw/edge deploy
```

The committed config is **production-strict**: `ALLOW_FAKE_ADAPTERS` is empty,
so a persistent (Hyperdrive) deployment refuses to boot on any dev fake (stub
AI, fake blob store, hash embeddings). A staging deployment that intentionally
runs without R2/embeddings/Anthropic uses
`pnpm --filter @cw/edge deploy:staging`, which passes
`ALLOW_FAKE_ADAPTERS=ai,blob,embeddings` as a deploy-time `--var` instead of
committing the allowance.

Use Neon's **direct (unpooled)** endpoint behind Hyperdrive — Hyperdrive is the
pooler; stacking pgbouncer under it breaks transaction pinning. Migrations run
from any Node environment against Neon directly:
`DATABASE_URL=$NEON_URL pnpm --filter @cw/migrator start` (this also applies
the pgvector schema; set `SKIP_PGVECTOR=true` on databases without the
extension — Neon has it).

## Local development

```bash
docker compose up -d postgres            # or any local Postgres with pgvector
DATABASE_URL=postgres://postgres:postgres@localhost:5432/contentworker pnpm --filter @cw/migrator start
pnpm --filter @cw/edge dev               # miniflare emulates KV/Queues/DO/Workflows/Vectorize;
                                         # Hyperdrive uses localConnectionString from wrangler.jsonc
pnpm --filter @cw/edge exec wrangler dev -e demo   # zero-infra demo (in-memory store, dev keys)
```

## Deployment topologies: one worker or three

The edge target ships in two mutually exclusive topologies from the same
`wrangler.jsonc`:

| | All-in-one (default) | Scale-out (enterprise) |
| --- | --- | --- |
| Workers | 1 (`cw-edge`) | 3 (`cw-edge-pipeline` / `-management` / `-delivery`) |
| Deploy | `wrangler deploy` | `wrangler deploy -e pipeline` → `-e management` → `-e delivery` |
| Serves | everything on one hostname | one hostname per plane (e.g. `cdn.` / `cms.`) |
| Best for | most deployments, staging, single-team | isolation of blast radius, limits, and attack surface |

**Pick the all-in-one worker unless you have a concrete isolation
requirement.** Every Cloudflare Worker already autoscales horizontally across
isolates and PoPs on its own — the three-way split adds *zero* throughput.
What it buys is operational isolation:

- **Blast radius** — a bad deploy or crash loop in the authoring plane cannot
  take down the public read plane, and vice versa. Each worker versions,
  deploys, and rolls back independently.
- **Capability isolation by construction** — the delivery worker physically
  has no `EVENTS_QUEUE` binding and no cron trigger, so it *cannot* mutate
  content or run scheduled publishes even if a bug tried. The split is
  enforced by absent bindings, not by code paths.
- **Attack surface** — the pipeline worker (all the privileged background
  work) has `workers_dev: false` and no routes: it is unreachable over HTTP
  entirely. It exists only for queues, cron, and the stateful classes.
- **Independent limits and config** — per-worker CPU limits, rate-limit
  posture, custom domains, and secrets.

This is the Workers analogue of the Helm chart's monolith-vs-split API
topology (`api.split.enabled` — see [deployment.md](deployment.md)); the
`ROLE` var drives both.

### The three workers

- **`cw-edge-pipeline`** — the event backbone: queue consumers (`cw-events`,
  `cw-agents`, DLQ), the cron sweeper, agents — and the **owner of every
  Durable Object class and the AgentWorkflow**. Not publicly reachable.
- **`cw-edge-management`** — Management API + MCP + the admin SPA
  (`ROLE=management`); produces onto `cw-events` (outbox nudges) and signals
  review-watcher Workflows via the cross-script `AGENT_WF` binding.
- **`cw-edge-delivery`** — the public read plane: `ROLE=delivery,preview`
  mounts the Delivery + Preview APIs and the DO-served SSE hub. Read-only for
  content: no queue producer, no cron. (`ROLE` accepts a comma-separated
  union, so drafts don't need a fourth worker.)

### What stays shared

Splitting the compute does **not** split the state. All three workers bind
the same Hyperdrive, KV namespace, and Vectorize index as the all-in-one
deployment, and there is still exactly **one set of Durable Objects**:
Durable Object classes live in the worker that declares their migrations
(pipeline), and delivery/management reach the *same instances* through
`script_name` bindings. Concretely:

| State | Owner | Bound by | Why it must be shared |
| --- | --- | --- | --- |
| `LiveHubDO` (SSE hub per space:env) | pipeline | delivery | pipeline publishes events into the hub instances delivery's subscribers are parked on — different instances would silently drop live updates |
| `RateLimiterDO` (per client IP) | pipeline | delivery + management | one global failed-auth budget per IP across all planes |
| `CostGuardDO` (per-space AI budget) | pipeline | management | generation (management) and agents (pipeline) draw down one shared window |
| `AgentWorkflow` | pipeline | management | review decisions on the Management API signal watcher runs executing in pipeline |

### Deploying

```bash
# Deploy order matters — pipeline first (it creates the DO/Workflow classes
# the other two workers' script_name bindings point at):
wrangler deploy -e pipeline
wrangler deploy -e management     # build the admin SPA first (assets)
wrangler deploy -e delivery
```

Secrets are per-worker (`wrangler secret put <NAME> -e <env>`). Every worker
needs `ADMIN_TOKEN`, `TOKEN_PEPPER`, `CMA_KEY`, `CDA_KEY`, `CPA_KEY`
(`REQUIRE_SECURE_SECRETS=true` refuses dev defaults) — set the **same values
on all three**: they share one database, and a per-worker `TOKEN_PEPPER`
would break API-key auth across workers. Management additionally needs
`SESSION_SECRET` + `MCP_TOKEN`; management + pipeline need
`ANTHROPIC_API_KEY`. Attach zone routes per env in `wrangler.jsonc`
(commented placeholders).

Per-env vars are deliberately minimal (code defaults + the fail-closed adapter
guard catch drift).

### Cutting over from the all-in-one worker

Scale-out **replaces** `cw-edge` rather than running beside it: a queue can
have only one consumer worker, and the Workflow name `cw-agent` is
account-unique, so `wrangler deploy -e pipeline` fails while `cw-edge` still
holds them. Cut over by deleting the all-in-one worker (or redeploying it
without queue consumers and the workflow) before deploying pipeline. The
Neon/KV/Vectorize/R2 data plane is untouched by the cutover; note that
Durable Object state (live SSE subscribers, in-flight rate-limit windows,
budget counters) starts fresh in the new pipeline worker — all of it is
short-lived by design.

Going back is the reverse: delete the three workers, redeploy `cw-edge`.

### Maintainer note: wrangler env inheritance

Wrangler named environments inherit `triggers`, `assets`, and `migrations`
from the top-level config (while inheriting almost no other bindings), so
each scale-out env pins all three explicitly (`env.demo` is standalone and
intentionally keeps the inherited SPA and cron). This is load-bearing: without the
overrides, the "read-only" delivery worker inherits the every-minute cron and
runs scheduled publishes (a mutation), every worker serves the admin SPA, and
non-owner workers create shadow DO namespaces that a dropped `script_name`
would silently point at. When adding a new env, start from an existing block
— never from empty.

## Semantics & tradeoffs vs the Node path

The full side-by-side matrix (including the Node column) lives in
[Consistency & guarantees](./consistency.md); the highlights for this target:

- **Delivery cache staleness:** KV propagates writes eventually; a publish can
  be served stale from a remote PoP for up to ~60s (tag versions are re-read on
  every hit, so within-PoP invalidation is immediate). CDN-class semantics,
  Delivery API only. Strict-freshness deployments unset `KV_CACHE`.
- **Scheduled publishing granularity:** the cron sweeper fires every minute, so
  scheduled publish/unpublish executes within 60s of its wall-clock time
  (vs 5s on the Node worker).
- **Event latency:** the post-commit nudge relays the outbox in-request
  (sub-second); the cron sweeper only catches events orphaned by a crash.
  Double-relay races are safe — dispatch is idempotent on the event id and the
  contract is at-least-once (`dedupeKey` is a no-op on Cloudflare Queues).
- **Vectorize indexing lag:** upserts/deletes are async-indexed (seconds), so
  search-after-publish is not immediate — same class of lag as queue-driven
  embedding on the Node path.
- **Agent runs consume from their own queue:** `cw-events` forwards each
  published entry's agent work to `cw-agents` (batch size 1), so a batch of
  events never has to fit N polled Workflow runs inside one consumer
  invocation. Without the `AGENTS_QUEUE` binding, agents run inline in the
  events consumer (dev/demo parity).
- **Bulk reindex runs in bounded slices:** each `search.reindex_requested`
  message embeds at most a few hundred entries, then re-enqueues a
  continuation event carrying a keyset cursor (relayed immediately after the
  batch) — a full reindex never has to fit one consumer invocation's
  CPU/subrequest limits. Redelivered slices are deduped via a best-effort
  cache marker; a duplicate that slips through re-embeds already-indexed
  entries (idempotent — wasted work, never wrong data).
- **Dead letters are visible:** the `cw-events-dlq` consumer logs each
  dead-lettered message loudly and acks it, so poison events surface in
  observability instead of vanishing when retries are exhausted.
- **Agent duplicate runs:** if a queue consumer retries after starting an agent
  workflow, a duplicate instance runs. Runs are recorded proposals (never
  direct state changes), so duplicates are benign ledger noise.
- **Live Content requires the `LIVE_HUB` binding:** without it the stock SSE
  route still mounts but only emits keepalives (no cross-isolate bus exists on
  Workers) — same behavior as the Node API without Redis.
- **Per-request wiring:** postgres.js sockets cannot cross Worker requests, so
  the store connects per request through Hyperdrive's edge pool. Watch p50 —
  if GraphQL schema rebuilds show up hot, the schema cache can move to module
  scope.

## Verification (staging checklist)

1. Contract tests against a Hyperdrive-fronted Neon branch:
   `TEST_DATABASE_URL=<hyperdrive-local-url> pnpm --filter @cw/adapter-store-postgres test`
   (transactions, jsonb/array decoding with `fetch_types: false`).
2. `curl /healthz`; author → publish via CMA key; delivery read via CDA key.
3. Presigned upload: `POST …/assets` → PUT to the returned R2 URL → publish.
4. Publish an entry with a webhook subscribed → delivery recorded in
   `webhook_deliveries`, DLQ empty, KV cache invalidated (read-after-publish).
5. `curl -N …/delivery/:space/:env/live` while publishing → events + pings.
6. `AGENTS_ENRICH=true` publish → `wrangler workflows instances list cw-agent`
   shows a completed instance and the run appears in the agent ledger.
7. Semantic + hybrid search return the published entry (allow seconds of
   Vectorize indexing lag); cross-space isolation holds.

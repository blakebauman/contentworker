# Cloudflare deployment (`apps/edge`)

contentworker's second deployment target: one Cloudflare Worker runs the entire
platform — Management/Delivery/Preview APIs, the admin SPA, the MCP server, the
event pipeline, the Live Content API, and the durable agents — against **Neon
Postgres via Hyperdrive**. The Node + Kubernetes/compose path (see
[deployment.md](deployment.md)) remains fully supported for self-hosting; both
targets share the same hexagonal core and differ only in adapters and
composition roots.

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
wrangler queues create cw-events && wrangler queues create cw-events-dlq
wrangler r2 bucket create cw-assets    # + an R2 S3-API token for presigning

# paste the hyperdrive/kv ids into apps/edge/wrangler.jsonc, then
wrangler secret put ADMIN_TOKEN         # + MCP_TOKEN, TOKEN_PEPPER, SESSION_SECRET,
                                        #   ANTHROPIC_API_KEY, AWS_ACCESS_KEY_ID/SECRET (R2)
pnpm --filter @cw/admin build
pnpm --filter @cw/edge deploy
```

Use Neon's **direct (unpooled)** endpoint behind Hyperdrive — Hyperdrive is the
pooler; stacking pgbouncer under it breaks transaction pinning. Migrations run
from any Node environment against Neon directly:
`DATABASE_URL=$NEON_URL pnpm --filter @cw/migrator start` (this also applies
the pgvector schema; set `SKIP_PGVECTOR=true` on databases without the
extension — Neon has it).

## Local development

```bash
docker compose up -d postgres            # or any local Postgres with pgvector
DATABASE_URL=postgres://cw:cw@localhost:5432/contentworker pnpm --filter @cw/migrator start
pnpm --filter @cw/edge dev               # miniflare emulates KV/Queues/DO/Workflows/Vectorize;
                                         # Hyperdrive uses localConnectionString from wrangler.jsonc
pnpm --filter @cw/edge exec wrangler dev -e demo   # zero-infra demo (in-memory store, dev keys)
```

## Scale-out (enterprise)

One deploy is a complete system. To isolate blast radius and limits at scale,
deploy the same script per role with wrangler environments — `env.delivery`,
`env.management`, `env.pipeline` — overriding `ROLE` and routes, and attach the
`cw-events` consumer only to the pipeline deployment. Workers autoscale
horizontally regardless; the split is operational isolation, not throughput.

## Semantics & tradeoffs vs the Node path

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

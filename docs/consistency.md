# Consistency & guarantees per deployment target

The same application core runs on two families of infrastructure with
different building blocks. The **invariants are identical everywhere**; the
**timing and staleness envelopes differ**. This page is the honest matrix so
you can pick a target (or configure one) with eyes open.

The two targets compared:

- **Node/K8s** — `apps/api` + `apps/worker` (+ optional `mcp-server`,
  `agent-worker`) with Postgres, Redis (cache + BullMQ), S3-compatible blobs.
- **Cloudflare edge** — one Worker (`apps/edge`) with Neon via Hyperdrive,
  KV cache, Cloudflare Queues, Vectorize, Durable Objects, R2.

## Invariants that hold on every target

- **Writes are transactional** in Postgres, and publish writes the read model
  **and** the outbox event in the same transaction — an event exists iff the
  commit happened.
- **Event delivery is at-least-once**, never at-most-once: relay claims rows
  with `FOR UPDATE SKIP LOCKED`; consumers are idempotent on the event id;
  webhook receivers should dedupe on it.
- **Reads of your own writes through the Management/Preview APIs** hit
  Postgres directly — always fresh, on both targets.
- **RBAC and budgets are enforced in the application layer**, identically for
  HTTP and MCP callers.
- **Bulk reindex** runs as a queued background job in bounded slices with a
  keyset continuation cursor on both targets.

## The matrix

| Behavior | Node/K8s | Cloudflare edge |
| --- | --- | --- |
| Delivery read after publish (cached) | Redis tags invalidated by the worker ≈1 s after commit; strict read-your-write once invalidated | KV is eventually consistent: remote PoPs can serve stale for up to **~60 s** (within-PoP invalidation is immediate; KV also enforces a 60 s minimum TTL). Strict-freshness deployments unset `KV_CACHE` |
| Event latency (webhooks, cache, RAG) after a mutation | ≈1 s (relay poll interval, `RELAY_INTERVAL_MS`) | Sub-second (post-commit relay nudge); worst case ~60 s via the cron sweeper after a crash |
| Scheduled publish/unpublish at time T | Fires within ~5 s (`SCHEDULE_INTERVAL_MS`) | Fires within ~60 s (1-minute cron granularity) |
| Recurring agent schedule due at time T (`AGENTS_SCHEDULES=true`) | Fires within ~60 s (worker poll, `AGENT_SCHEDULE_INTERVAL_MS`, default 60 s) | Fires within ~60 s (1-minute cron). Otherwise identical semantics on both targets: each firing is claimed via CAS on `nextRunAt`, so concurrent runners (replicas, rolling updates, worker + edge cron together) never double-run one |
| Duplicate event delivery | Rare — the relay claims rows transactionally (`FOR UPDATE SKIP LOCKED`), and the relay passes the event id as the BullMQ job id, so a crash-between-enqueue-and-commit redelivery is collapsed producer-side while the twin job is retained (last 1000 completed; a *failed* twin is retried, not deduped); consumers stay idempotent regardless | Same at-least-once guarantee (nudge and cron sweeper skip each other's claimed rows); Cloudflare Queues ignores the producer dedupe key and consumer retries can also redeliver — consumers stay idempotent |
| Semantic search visibility after publish | pgvector rows are visible as soon as the dispatch commits | Vectorize indexes asynchronously — expect **seconds** of extra lag; Vectorize also declares a 50-chunk per-query cap (`VectorStore.maxTopK`, honored by the search over-fetch) vs up to 400 with pgvector, so recall on chunk-heavy content can differ |
| Live Content SSE | Redis pub/sub fan-out across pods; without Redis: keepalives only | `LiveHubDO` fan-out (one object per space:environment); a DO restart drops connected streams (clients reconnect); without the binding: keepalives only |
| On-publish agents | In-process (non-durable) or Temporal (durable, blocking result) | Cloudflare Workflows via the dedicated `cw-agents` queue; the consumer starts a chunked instance and acks (fire-and-forget), so a retry can start a duplicate pass — mostly benign (runs are recorded proposals), except that a duplicate moderation hold re-retracts the entry |
| **Moderation coverage** | `AGENTS_MODERATE_BLOCKING` gates **single-entry publish only** (API route + MCP tool). Bulk publish, bulk jobs, release publish and scheduled publishes are **not** gated: they rely on post-publish moderation, so flagged content is briefly live and is retracted once the classifier holds it. Gating them would mean one inline model call per entry, which their throughput cannot absorb. | Same, plus the extra queue hop below |
| Agent/moderation retraction lag | Same dispatch cycle | One extra queue hop (events consumer → agents queue) |
| AI budget metering | Redis-shared across replicas; in-process window fallback still meters per pod | `CostGuardDO`, shared across colos; **absent binding = unmetered** |
| Auth rate limiting | Redis-shared across pods; per-process fallback | `RateLimiterDO` per client IP, global; per-isolate fallback |
| Reindex cooldown / duplicate-slice dedupe | Redis-backed — consistent | KV-backed — approximate across colos (concurrent accepts possible; slices stay idempotent) |
| Dead letters | BullMQ retains failed jobs (last 5000) for inspection | `cw-events-dlq` consumer logs each dead letter loudly and acks |
| MCP surface | Separate `mcp-server` deployment; the dev token only exists on the in-memory store — with `DATABASE_URL` set and no `MCP_TOKEN` it fails closed | Mounted into the Worker (management role); suppressed on persistent deployments unless an explicit `MCP_TOKEN` is set (fail closed) |
| Connection model | Long-lived pools, prepared statements | Per-request connect through Hyperdrive's edge pool (unpooled Neon endpoint **required** — a direct `DATABASE_URL` with a `-pooler` host is rejected at boot) |

## Choosing / tuning

- **Content API latency worldwide, CDN-class freshness is fine** → edge. The
  ~60 s KV envelope matches how CDNs already behave for delivery traffic.
- **Strict read-after-publish for delivery reads** → Node/K8s with Redis, or
  edge with `KV_CACHE` unset (every read hits Neon through Hyperdrive).
- **Second-precision scheduled publishing** → Node/K8s (5 s loop), or accept
  the minute cron on edge.
- **Search-heavy workloads with large entries** → pgvector honors deep
  candidate pools; Vectorize's 50-chunk cap can flatten recall.
- **Durable agents with blocking results** → Temporal on K8s; Cloudflare
  Workflows are durable but polled, and sized for fire-and-observe.

Related: [Events & webhooks](./events-and-webhooks.md) for the pipeline
mechanics, [Cloudflare](./cloudflare.md) for edge operations, and
[Backup & restore](./backup-and-restore.md) for the durability side.

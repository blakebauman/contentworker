# Events, async backbone & webhooks

contentworker uses a **transactional outbox** so that domain events are emitted exactly when (and
only when) their state change commits. A background worker relays those events and fans them out.

## The pipeline

```
  publishEntry / unpublishEntry / publishContentType
        │  (inside ONE store.withTransaction)
        ├─ write the denormalized read model (entry_published / removePublished)
        └─ outbox.append(event)                ← event is durable iff the tx commits
                                   │
        apps/worker: relayOutbox  │  every RELAY_INTERVAL_MS
        ├─ outbox.readPending(N)  ▼
        ├─ queue.enqueue(EVENTS_TOPIC, event)        (BullMQ on Redis)
        └─ outbox.markRelayed(ids)
                                   │
        apps/worker: queue.process(EVENTS_TOPIC)
        └─ dispatchEvent(ctx, { sender, cache, rag, invoker }, event)
             ├─ webhooks  — fan out to subscribers (HMAC-signed)
             ├─ functions — invoke user-defined HTTP hooks (FunctionInvoker)
             ├─ cache     — invalidate the entry's tag + reverse-reference tags
             └─ rag       — re-index (published) or delete (unpublished) embeddings
                                   │
        (after dispatch) bus.publish(event)  →  Live Content SSE subscribers
                                   │
        runPublishAgents (optional) on entry.published
                                   │
        runDueScheduledActions every SCHEDULE_INTERVAL_MS
                                   │
        runDueAgentSchedules every AGENT_SCHEDULE_INTERVAL_MS   (AGENTS_SCHEDULES=true)
```

`EVENTS_TOPIC` is `cw.events`.

## Transactional outbox

The `OutboxRepo` port:

```ts
interface OutboxRepo {
  append(event: DomainEvent): Promise<void>;      // same tx as the state change
  readPending(limit: number): Promise<DomainEvent[]>;
  markRelayed(eventIds: readonly string[]): Promise<void>;
}
```

In Postgres, the `outbox` table has a partial index on `occurredAt WHERE relayedAt IS NULL`, so
draining pending events is cheap. Because `append` runs in the same transaction as the publish,
there is **no window** where the read model is updated but the event is lost, or vice versa.

## Relay loop

`relayOutbox(ctx, queue, opts?)` (`events/relay.ts`) reads a batch of pending events (default 100),
enqueues each onto `EVENTS_TOPIC`, and marks them relayed. The worker calls it on an interval
(`RELAY_INTERVAL_MS`, default 1000 ms). Delivery is **at-least-once**, which is why dispatch is
idempotent (keyed on `event.id`).

## Dispatch

`dispatchEvent(ctx, deps, event)` (`events/dispatch.ts`) fans out to:

1. **Webhook fan-out** — active subscribers for `event.type`, HMAC-signed POST, delivery log.
2. **User-defined functions** — `FunctionInvoker` POSTs to registered HTTP functions for matching
   event types (`packages/application/src/functions.ts`).
3. **Cache invalidation** (on `entry.published` / `entry.unpublished`) — tag set includes reverse
   references; `cache.invalidateTag` per tag.
4. **RAG indexing** — `indexEntryEmbeddings` on publish, `removeEntryEmbeddings` on unpublish.
5. **Lexical search index** (when `SEARCH_PROVIDER=opensearch` binds a `SearchIndex`) — the
   published entry's text is indexed on publish and removed on unpublish, keeping the external
   BM25 leg of hybrid search fresh.

`DispatchDeps` is `{ sender, cache?, rag?, invoker?, searchIndex? }` — optional deps degrade
gracefully.

After dispatch, the worker publishes the event on the Redis **`EventBus`** for Live Content SSE
(`GET /delivery/:space/:env/live`). On `entry.published`, optional on-publish agents run via
`runPublishAgents` when `AGENTS_ENRICH` / `AGENTS_MODERATE` are enabled.

A separate loop calls `runDueScheduledActions` every `SCHEDULE_INTERVAL_MS` (default 5000 ms) to
execute deferred publish/unpublish actions.

When `AGENTS_SCHEDULES=true`, a third loop calls `runDueAgentSchedules` every
`AGENT_SCHEDULE_INTERVAL_MS` (default 60 000 ms) to execute recurring agent jobs over entries
published since each schedule's previous run. Firings are claimed via compare-and-swap on the
schedule's `nextRunAt`, so worker replicas (or the edge cron) never double-run one. See
[AI, agents & search](./ai-agents-and-search.md#agent-schedules).

## Webhooks

Register a webhook through the Management API (`POST …/webhooks`, scope `space:admin`):

```jsonc
{
  "url": "https://example.com/hook",
  "topics": ["entry.published", "entry.unpublished"],  // or ["*"] for all
  "secret": "whsec_...",          // HMAC signing secret
  "active": true,
  "headers": { "X-Env": "prod" }  // optional static headers
}
```

The worker's `WebhookSender` (`apps/worker/src/webhook-sender.ts`) signs the JSON payload with
HMAC-SHA256 using the webhook's `secret` and POSTs it. Each attempt is logged as a
`webhook_deliveries` row for observability. A failed dispatch throws so BullMQ retries
(exponential backoff, then dead-letters).

### Event payloads

| `type` | Payload (besides `id`, `scope`, `occurredAt`) |
| --- | --- |
| `entry.published` | `entryId`, `contentTypeApiId`, `version`, `fields` |
| `entry.unpublished` | `entryId`, `contentTypeApiId` |
| `content_type.published` | `contentTypeApiId`, `version` |
| `release.published` | `releaseId`, `entryIds` |

## Delivery cache

The `Cache` port is a read-through cache with **tag-based invalidation**. The Redis adapter
(`@cw/adapter-redis`) stores each cached render under a key and registers that key in a Redis set
per tag; `invalidateTag` deletes every member of the set. Cached entries default to a 300 s TTL
(tag sets live slightly longer to avoid dangling references).

A cache is only attached when `REDIS_URL` is set. In pure in-memory dev (no worker), Delivery
reads go straight to the store and stay fresh. In production the worker is what invalidates tags
after a publish, so Delivery serves cached reads that are correctly busted on change — including
for entries that *embed* the changed one, thanks to the reverse-reference tag set.

## Queue adapter

`createRedisQueue` implements the `Queue` port over BullMQ: one queue per topic, 5 retry attempts
with exponential backoff, and automatic job cleanup after success/failure. BullMQ requires
`maxRetriesPerRequest: null` on the ioredis connection (the worker sets this).

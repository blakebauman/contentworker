# Backup, restore & disaster recovery

What to back up, what is derivable, and how to recover — per deployment target.

## What holds state

| Store | Holds | Recoverable from elsewhere? |
| --- | --- | --- |
| **Postgres** | The system of record: spaces, content types, entries + versions, published read model, references, assets metadata, API keys (hashed), roles, webhooks + deliveries, releases, scheduled actions, comments/tasks/workflows, taxonomy, audit log, agent runs, **transactional outbox** | **No — back this up.** |
| **Blob store (S3-compatible)** | Asset binaries (masters) | **No — back this up** (bucket versioning/replication). |
| **Vector store** (pgvector / Vectorize) | Embedding chunks for semantic search | Yes — rebuild with a [reindex](./ai-agents-and-search.md) per space. |
| **Redis** | Delivery cache (derivable), auth rate-limit windows and AI budget windows (expendable), **BullMQ queue state** (see below) | Cache/windows: yes. Queue state: partially — see the replay note. |
| **Temporal** (when `AGENT_RUNTIME=temporal`) | Durable agent workflow state | Agent runs are recorded proposals; an interrupted run can simply be re-triggered. Follow [Temporal's own persistence backup guidance](https://docs.temporal.io) for the cluster database. |

Everything else — the container image, Helm values, wrangler config — is in git.

## The one subtle case: Redis and in-flight events

The outbox relay marks a row `relayed_at` **when it enqueues the event onto
BullMQ**, inside the same transaction that read it. From that moment until a
worker finishes dispatching it, the event lives only in Redis. A Redis loss
therefore drops *queued-but-not-yet-dispatched* events (webhooks, cache
invalidation, RAG indexing for those events) even though Postgres is intact.

Mitigations, in order of preference:

1. Run Redis with persistence (AOF `everysec`, or a managed tier with
   persistence — ElastiCache/Memorystore/Azure Cache all offer it).
2. **Replay from the outbox** — relayed rows are retained, not deleted, so
   recovery is one statement away:

   ```sql
   -- Re-relay everything enqueued in the suspect window (dispatch is
   -- idempotent on the event id; webhook receivers dedupe on it too):
   UPDATE outbox SET relayed_at = NULL
   WHERE relayed_at > now() - interval '1 hour';
   ```

   The worker's relay loop picks the rows up again within a second.
3. For search staleness specifically, `POST …/search/reindex` rebuilds
   embeddings without touching the event pipeline.

The Cloudflare target has no equivalent gap: Cloudflare Queues persists
messages, and the same outbox-replay statement works against Neon regardless.

## Per-target backup guidance

### On-prem (bundled Postgres/Redis — local & evaluation only)

The bundled Postgres StatefulSet (2 Gi PVC) and Redis Deployment ship **no
backups, no PITR, no replication**. They exist for kind/minikube and demos.
Anything you would grieve losing should run on an external Postgres with a
real backup regimen (`pgBackRest`, `wal-g`, or your platform's operator) —
point `DATABASE_URL` at it and set `postgres.bundled: false`.

Minimum viable on-prem regimen for a real cluster:

- Nightly base backup + continuous WAL archiving (PITR) for Postgres.
- Redis AOF persistence, or accept the outbox-replay procedure above as the
  recovery path.
- Object-store versioning (MinIO supports bucket versioning) for assets.
- Periodically **test a restore** into a scratch namespace: restore the dump,
  run the migrator (idempotent), boot the api, spot-check content.

### Managed cloud (RDS / Cloud SQL / Azure Database)

Enable the platform's automated backups + PITR (RDS automated backups, Cloud
SQL PITR, Azure flexible-server PITR) and cross-region replication if your RTO
demands it. ElastiCache/Memorystore persistence covers the Redis note. S3/GCS
versioning + lifecycle rules cover assets.

### Cloudflare edge (Neon + R2)

- **Neon** has PITR built in (restore to any point within your history
  window) and branch-based restore: create a branch at a timestamp, verify,
  then promote. The history-retention window is plan-dependent — check it
  matches your RPO.
- **R2** — enable object versioning on the assets bucket.
- **Vectorize** is derivable: after a Neon restore, trigger a reindex per
  space; Vectorize re-fills asynchronously.
- **KV cache** needs nothing: tag versions regenerate on the next publish.

## Restore procedure (any target)

1. Restore Postgres to the target point in time.
2. Run the migrator against it (`pnpm --filter @cw/migrator start`) — it is
   idempotent and a no-op if the schema matches.
3. Restore/verify the blob bucket (or accept the versioned bucket as-is).
4. Boot the stack; API keys keep working (hashes live in Postgres).
5. `POST …/search/reindex` per space to rebuild vectors (runs as a queued
   background job in bounded slices).
6. If events may have been lost around the incident window, run the
   outbox-replay statement above — downstream consumers dedupe on event id.

**RPO** is your Postgres backup granularity (continuous WAL/PITR ≈ seconds);
everything derivable rebuilds from it. **RTO** is dominated by the Postgres
restore itself — the stateless services redeploy in seconds.

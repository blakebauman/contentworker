# Configuration

contentworker is a 12-factor app: **all** configuration is environment variables, and adapter
selection is driven by which ones are set. The same image runs anywhere; only the values change.

## Adapter selection at a glance

| If set… | …this adapter is used | …otherwise |
| --- | --- | --- |
| `DATABASE_URL` | Postgres store + pgvector | in-memory store + in-memory vectors (dev/tests) |
| `REDIS_URL` | Redis cache + BullMQ queue | no cache (fresh reads); worker needs it |
| `BLOB_BUCKET` | S3-compatible blob store | fake in-memory blob store |
| `AI_PROVIDER=azure-openai` | Azure OpenAI generation | Anthropic (default) |
| `EMBEDDINGS_PROVIDER=azure-openai` | Azure OpenAI embeddings | local deterministic embeddings |
| `EMBEDDINGS_PROVIDER=openai` | Any OpenAI-compatible embeddings endpoint (OpenAI, Ollama, vLLM, TEI) | local deterministic embeddings |
| `VECTOR_PROVIDER=qdrant` | Qdrant VectorStore (self-hostable) | pgvector (Node, with `DATABASE_URL`) / Vectorize (edge) |
| `SEARCH_PROVIDER=opensearch` | OpenSearch lexical index (BM25) for hybrid search | built-in Postgres FTS |

## Core / infrastructure

| Var | Default | Purpose |
| --- | --- | --- |
| `ROLE` | `all` | API surface: `all` / `management` / `delivery` / `preview`, or a comma-separated union (e.g. `delivery,preview`) |
| `PORT` | `8787` (api), `8788` (mcp-server) | HTTP listen port |
| `DATABASE_URL` | — | Postgres connection string; absent → in-memory store |
| `REDIS_URL` | — | Redis connection string; absent → no cache (and the worker won't start) |
| `DELIVERY_LIST_TTL_SECONDS` | `3600` | TTL for cached delivery **list** results. Lists are invalidated by content-type tags (a publish of the type evicts them), so the TTL is the backstop; only typed, non-cursor queries are cached |
| `DELIVERY_CACHE_TTL_SECONDS` | `86400` | TTL on delivery cache entries — a garbage-collection bound so the cache backend doesn't accumulate every render forever; tag-version invalidation stays the correctness mechanism |
| `MAX_BODY_BYTES` | `5242880` | Max accepted request body size (DoS guard); oversized → 413 |
| `TRUSTED_PROXY_COUNT` | `1` | Reverse proxies in front; X-Forwarded-For is read this many hops from the right (spoof-resistant rate-limit keying). `0` ignores XFF |
| `NODE_ENV` | `production` | Set in the Dockerfile |

## API keys (dev seeds)

| Var | Default | Purpose |
| --- | --- | --- |
| `CMA_KEY` | `dev-cma-key` | Seeded Content Management token (write) |
| `CDA_KEY` | `dev-cda-key` | Seeded Content Delivery token (read published) |
| `CPA_KEY` | `dev-cpa-key` | Seeded Content Preview token (read drafts) |
| `ADMIN_TOKEN` | `dev-admin-token` | Root token — all scopes, all spaces (provisioning) |

### Production hardening

| Var | Default | Purpose |
| --- | --- | --- |
| `REQUIRE_SECURE_SECRETS` | off (auto when `NODE_ENV=production`) | Fail startup on dev default tokens, short secrets, or `SEED_DEV=true`. Set `false` in local docker-compose to allow dev tokens despite `NODE_ENV=production` in the image. |
| `ALLOW_FAKE_ADAPTERS` | — | A persistent deployment (`DATABASE_URL`/Hyperdrive set) refuses to boot when a dev fake is silently bound (stub AI, fake blob store, hash embeddings, in-memory vectors). This names the fakes a deployment accepts deliberately: a comma-separated list of `ai`, `blob`, `embeddings`, `vectors` — or `all`. An explicit `EMBEDDINGS_PROVIDER=local` already counts as consent and needs no entry here. |
| `TOKEN_PEPPER` | — | Server-side pepper mixed into API key hashes at rest |
| `AUTH_RATE_LIMIT_MAX` | `10` | Failed auth attempts per IP before HTTP 429 |
| `AUTH_RATE_LIMIT_WINDOW_MS` | `60000` | Rate-limit sliding window (ms) |

### Admin auth (OIDC SSO on `@cw/api`)

OIDC routes mount on the Management API when `ROLE=all` or `management`:

| Route | Purpose |
| --- | --- |
| `GET /auth/oidc/login` | Redirect to IdP |
| `GET /auth/oidc/callback` | PKCE callback; sets httpOnly session cookie |
| `POST /auth/logout` | Revokes delegated key + clears cookie |
| `GET /auth/me` | Principal probe (bearer or session cookie) |

| Var | Default | Purpose |
| --- | --- | --- |
| `OIDC_ISSUER` | — | OIDC provider issuer URL |
| `OIDC_CLIENT_ID` | — | OAuth client id |
| `OIDC_CLIENT_SECRET` | — | OAuth client secret |
| `OIDC_REDIRECT_URI` | — | Callback URL (`/auth/oidc/callback` on the API origin) |
| `OIDC_DEFAULT_SPACE` | `space-1` | Space for delegated CMA keys |
| `OIDC_GROUP_ROLE_MAP` | `{}` | JSON map of IdP group → role id |
| `OIDC_DEFAULT_ROLE` | — | Role id assigned to authenticated users whose groups match no map entry. When unset, unmapped logins are **refused** (fail closed) instead of receiving a full CMA key. |
| `SESSION_SECRET` | — | HMAC secret for the httpOnly session cookie |
| `SESSION_TTL_HOURS` | `8` | Session lifetime |
| `ADMIN_UI_URL` | `http://localhost:5173/dashboard` | Post-login redirect |

Admin SPA: proxied `/auth/oidc/login` works same-origin in dev; optional `VITE_SSO_LOGIN_URL` override.

In Postgres mode these seeds are not used; create real keys via `POST …/api-keys`.

## Seeding the in-memory store

| Var | Default | Purpose |
| --- | --- | --- |
| `SEED_SPACE_ID` | `space-1` | Seed space id |
| `SEED_ENV_ID` | `main` | Seed environment id |
| `SEED_DEFAULT_LOCALE` | `en-US` | Seed default locale |
| `SEED_LOCALES` | `en-US` | Comma-separated locale list |

### Demo dataset (`SEED_DEV`, `SEED_SCALE`)

| Var | Default | Purpose |
| --- | --- | --- |
| `SEED_DEV` | `false` | When `true`, the API runs the idempotent `@cw/seed` bootstrap: space, dev keys, and a demo dataset covering every platform surface — all field types across eight content types, a generated entry corpus (drafts/changed/published), assets, taxonomy, releases, workflows, comments, tasks, webhooks, functions, extensions, AI actions, scheduled actions, agent runs/reviews/schedules, roles (plus a role-bound `dev-editor-key`), a `staging` environment with a `live` alias, and an audit trail. **Never enable in production.** docker-compose sets this to `true`; `pnpm --filter @cw/api dev` sets it too (opt out with `SEED_DEV=false pnpm --filter @cw/api dev`). |
| `SEED_SCALE` | `1` | Corpus multiplier for the generated entry types (articles/products/events/recipes). `1` ≈ 550 entries (demo); `100` ≈ 44k entries for content-at-scale benchmarks. Deterministic at every scale. |

The in-memory store always pre-seeds the space and dev keys regardless of `SEED_DEV`. The demo
dataset is marked complete with a `demo-seed-v3` tag; subsequent boots short-circuit on it, so
re-seeding after a dataset change means deleting that tag (or resetting the store). With Postgres
and `SEED_DEV=false`, create spaces and keys via the Management API.

## Blob storage (S3-compatible)

| Var | Default | Purpose |
| --- | --- | --- |
| `BLOB_BUCKET` | — | Bucket name; absent → fake blob store |
| `AWS_REGION` | `us-east-1` | Region |
| `AWS_ACCESS_KEY_ID` | — | Static credentials (optional when using IRSA/instance role) |
| `AWS_SECRET_ACCESS_KEY` | — | Static credentials |
| `BLOB_ENDPOINT` | — | Custom endpoint (MinIO, R2, GCS, Azure interop) |
| `BLOB_FORCE_PATH_STYLE` | — | `true` for MinIO and most S3-compatibles |
| `BLOB_PUBLIC_BASE_URL` | — | When set, download URLs are unsigned public URLs |

Supported backends: AWS S3, Cloudflare R2, MinIO, GCS (S3 interop), Azure Blob (S3 interop).
Uploads use presigned PUT URLs (default 900 s) so file bytes never transit the API.

## AI & embeddings

| Var | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `anthropic` | `anthropic` or `azure-openai` |
| `EMBEDDINGS_PROVIDER` | — | `azure-openai`, `openai`, `local`, or unset — see matrix below |
| `EMBEDDINGS_DIM` | `1536` | Embedding dimensions (must match the pgvector column) |
| `EMBEDDINGS_BASE_URL` | `https://api.openai.com/v1` | `openai` provider only: any OpenAI-compatible `/v1` endpoint — OpenAI, Ollama, vLLM, TEI, LocalAI (the self-hostable path) |
| `EMBEDDINGS_MODEL` | `text-embedding-3-small` | `openai` provider only: embedding model id as the server knows it |
| `EMBEDDINGS_API_KEY` | — | `openai` provider only: bearer token; omit for local servers without auth |
| `ANTHROPIC_API_KEY` | — | Anthropic key (default provider) |
| `ANTHROPIC_BASE_URL` | SDK default | Alternate Anthropic endpoint (LLM gateway / egress proxy / air-gapped mirror) |
| `AZURE_OPENAI_ENDPOINT` | — | e.g. `https://x.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI key |
| `AZURE_OPENAI_API_VERSION` | `2024-10-21` | API version |
| `AZURE_OPENAI_DEPLOYMENT` | — | Fallback deployment for all tiers |
| `AZURE_OPENAI_DEPLOYMENT_FLAGSHIP` | — | Deployment for the `flagship` tier (takes precedence) |
| `AZURE_OPENAI_DEPLOYMENT_BALANCED` | — | Deployment for the `balanced` tier |
| `AZURE_OPENAI_DEPLOYMENT_FAST` | — | Deployment for the `fast` tier |
| `AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT` | — | Embeddings deployment name |

Anthropic tier→model: `flagship`→`claude-opus-4-8`, `balanced`→`claude-sonnet-4-6`,
`fast`→`claude-haiku-4-5`. See [AI, agents & search](./ai-agents-and-search.md).

### Search backends (optional swaps)

| Var | Default | Purpose |
| --- | --- | --- |
| `VECTOR_PROVIDER` | — | `qdrant` swaps the VectorStore off pgvector/Vectorize |
| `QDRANT_URL` | `http://localhost:6333` | Qdrant HTTP endpoint (or Qdrant Cloud URL) |
| `QDRANT_API_KEY` | — | api-key header; omit for unauthenticated local instances |
| `QDRANT_COLLECTION` | `cw_embeddings` | Collection name (created on first use, Cosine) |
| `SEARCH_PROVIDER` | — | `opensearch` binds the external lexical index; publishes (and the reindex job) keep it fresh, hybrid search reads its ranking. Unset → Postgres FTS |
| `OPENSEARCH_URL` | `http://localhost:9200` | OpenSearch HTTP endpoint |
| `OPENSEARCH_USERNAME` / `OPENSEARCH_PASSWORD` | — | Basic auth; omit for unauthenticated clusters |
| `OPENSEARCH_INDEX` | `cw-entries` | Index name (created with mappings on first use) |

Both adapters are plain `fetch` — they run on the Node services and the edge
Worker alike. The OpenSearch index is maintained incrementally by publish
events; a bulk `POST …/search/reindex` also refreshes it when RAG
(`EMBEDDINGS_PROVIDER`) is configured.

### AI budget (per-space cost/rate guard)

Bounds AI spend per space over a rolling window so one tenant can't drive
unbounded LLM cost. Enforced on every generation across the API, MCP, worker, and
agent-worker (shared via Redis when configured, in-process otherwise). Set either
ceiling to `0` to disable metering.

| Var | Default | Purpose |
| --- | --- | --- |
| `AI_MAX_REQUESTS_PER_WINDOW` | `60` | Max AI requests per space per window (`0` disables) |
| `AI_MAX_TOKENS_PER_WINDOW` | `200000` | Max input+output tokens per space per window (`0` disables) |
| `AI_BUDGET_WINDOW_SECONDS` | `60` | Rolling window length |
| `AI_AGENT_MAX_REQUESTS_PER_WINDOW` | — | Separate, typically stricter window for BACKGROUND agent spend (scheduled + on-publish runs). Unset → background shares the standard window |
| `AI_AGENT_MAX_TOKENS_PER_WINDOW` | — | Token ceiling for the background window |
| `AI_AGENT_BUDGET_WINDOW_SECONDS` | `AI_BUDGET_WINDOW_SECONDS` | Background window length. On the edge target the background window counts separately (`agent:` DO name prefix) and enforces these AI_AGENT_* ceilings when set, falling back to the interactive ones. Leave the AI_AGENT_* vars genuinely unset to fall back — an empty-string var counts as configured |

> On Cloudflare (`apps/edge`) the budget is enforced by the `CostGuardDO`
> Durable Object (the `AI_BUDGET` binding) — shared across isolates and colos.
> Without the binding, edge AI calls are unmetered.

### API vs worker embeddings

| Surface | `EMBEDDINGS_PROVIDER` unset | `local` | `azure-openai` / `openai` |
| --- | --- | --- | --- |
| API (`wire.ts`) | Local deterministic embeddings | Local | Real provider |
| Worker RAG indexing | **Disabled** (no vectors on publish) | Enabled | Enabled |

Set `EMBEDDINGS_PROVIDER=local` (or a real provider) on the **worker** when you want
publish-time indexing. The API can still serve search with local embeddings when unset.

## Worker

| Var | Default | Purpose |
| --- | --- | --- |
| `RELAY_INTERVAL_MS` | `1000` | Outbox poll interval |
| `EVENT_RETENTION_HOURS` | `168` | Retention for relayed outbox rows + webhook delivery records; the worker (and the edge cron) sweeps them past this age so per-event history tables don't grow unbounded |
| `RETENTION_INTERVAL_MS` | `3600000` | Cadence of the retention sweep on the Node worker (edge sweeps on the top-of-hour cron tick) |
| `HEALTH_PORT` | `9464` | Health (`/healthz`, `/readyz`) + Prometheus `/metrics` port on the worker and agent-worker; on the API it serves `/metrics` only (health stays on the API port). Worker liveness fails only when the relay loop *hangs* (a tick that never returns); erroring ticks surface via `cw_relay_errors_total` instead of restart-looping |
| `AGENTS_ENRICH` | `false` | Run the enrich agent on `entry.published` (needs an AI provider) |
| `AGENTS_SCHEDULES` | `false` | Run recurring agent jobs (cron-based `agent-schedules`) from the worker loop / edge cron |
| `AGENT_SCHEDULE_INTERVAL_MS` | `60000` | Due-schedule poll cadence on the Node worker (edge uses the 1-minute cron) |
| `AGENT_SCHEDULE_MAX_ENTRIES` | `25` | Entry cap per schedule run; a truncated window resumes next firing |
| `AGENT_SCHEDULE_MAX_RUN_TOKENS` | `100000` | Token ceiling per schedule run; the run stops mid-batch once exceeded |
| `AGENTS_MODERATE` | `false` | Run the moderation agent on `entry.published` (classify; flagged content is retracted from delivery) |
| `AGENTS_MODERATE_BLOCKING` | `false` | Synchronous pre-publish gate: run moderation **before** publishing and reject (422) flagged content instead of retracting it after |
| `AGENTS_AUTO_APPLY` | `false` | Auto-apply enrichment vs. route to human review |
| `AGENT_RUNTIME` | — | `temporal` → durable workflows via Temporal; `cloudflare-workflows` → Cloudflare Workflows (edge target only); unset → in-process |
| `SCHEDULE_INTERVAL_MS` | `5000` | Poll interval for due scheduled publish/unpublish actions |

The worker **requires** both `DATABASE_URL` and `REDIS_URL`.

## Agent worker (Temporal)

The `apps/agent-worker` hosts durable `enrich`/`moderate`/`curate`/`repurpose` workflows when
`AGENT_RUNTIME=temporal`.

| Var | Default | Purpose |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |
| `TEMPORAL_TASK_QUEUE` | `contentworker-agents` | Task queue (worker may override when starting workflows) |

## Admin SPA

| Var | Default | Purpose |
| --- | --- | --- |
| `CW_API_URL` | `http://localhost:8787` | API target for the Vite dev/preview proxy |
| `CW_ADMIN_PORT` | `5173` | Admin listen port |
| `VITE_USE_POLLING` | — | `true` in Docker override for HMR over bind mounts |

See [Admin UI](./admin-ui.md).

## Observability

| Var | Default | Purpose |
| --- | --- | --- |
| `LOG_LEVEL` | `info` | Pino log level (`@cw/telemetry`) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | — | OpenTelemetry OTLP exporter endpoint |

Prometheus metrics (`prom-client`, Node services only — the edge Worker uses
Cloudflare observability): the API, worker, and agent-worker expose
`GET /metrics` on `HEALTH_PORT` (never on the ingress-exposed API port); the
MCP server serves it on its cluster-internal HTTP port. Counters cover outbox
relay volume and errors, consumed events by type/outcome, dispatch duration,
webhook delivery outcomes, and scheduled-action runs, plus process defaults.
In Helm, `metrics.serviceMonitor.enabled` renders Prometheus Operator
ServiceMonitors (`metrics.serviceMonitor.labels` for stack discovery). All
four Node services handle SIGTERM/SIGINT gracefully: in-flight work drains
(bounded by `terminationGracePeriodSeconds` in Helm) before connections close.
The API additionally serves `GET /health` as a bare-path alias for external
uptime monitors; Kubernetes probes use `/healthz` + `/readyz`.

## MCP server

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8788` | HTTP listen port |
| `MCP_TOKEN` | `dev-mcp-token` | Admin bearer token for MCP requests |

The MCP server also honours `DATABASE_URL`, `AI_PROVIDER`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_DIM`,
and the `SEED_*` vars.

## Migrator

| Var | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | required | Target database for Drizzle migrations |
| `EMBEDDINGS_DIM` | `1536` | Vector column width for the pgvector schema it applies |
| `SKIP_PGVECTOR` | `false` | `true` skips the pgvector schema (databases without the extension) |

## Cloudflare (`apps/edge`)

The Cloudflare Worker target reuses these var names verbatim; Cloudflare-native
resources (`HYPERDRIVE`, `KV_CACHE`, `EVENTS_QUEUE`, `VECTORIZE`, `LIVE_HUB`,
`AGENT_WF`) replace `DATABASE_URL`/`REDIS_URL` where a binding exists. See
[cloudflare.md](./cloudflare.md) for the mapping and provisioning steps.

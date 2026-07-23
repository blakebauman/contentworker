# contentworker

A composable, **API-first, AI-agentic-first** headless CMS — the AI surface is treated as
a first-class client rather than a bolt-on. Model structured content once and deliver it
anywhere (web, mobile, wearables, kiosks, IoT, email).

Built **cloud-agnostic** for Kubernetes (EKS/GKE/AKS) on a strict **ports & adapters**
core, so swapping clouds — Postgres vendor, object store, AI provider — is a config change,
not a code change.

---

## Highlights

- **Hexagonal core.** The domain depends on nothing; the application layer depends only on
  port interfaces; concrete adapters (Postgres, Redis, S3, Anthropic, Azure OpenAI, pgvector)
  are bound exactly once, in each app's composition root.
- **One set of use-cases, three callers.** The HTTP API, the MCP server (for AI agents), and
  the background worker all invoke the *same* application use-cases — so an AI agent can never
  perform an operation a human API client couldn't, and every write goes through the same
  validation and RBAC.
- **Structured content model.** 11 field types, per-field validation, localization with
  fallback chains, references with referential integrity, and assets with direct-to-S3 uploads.
- **Three-surface API split.** Management (CMA), Delivery (CDA), and Preview (CPA) surfaces,
  each gated by scoped, hashed API keys, mountable together or as independently-scaled services.
  Delivery is available as both REST and a **per-space GraphQL** schema generated from your model.
- **Event-driven backbone.** Publishing writes a denormalized read model *and* appends a domain
  event to a transactional outbox in one transaction; a worker relays it to a queue and fans it
  out to webhooks, cache invalidation, vector re-indexing, and optional AI enrichment.
- **AI built in.** Tiered model selection (`flagship`/`balanced`/`fast`), schema-validated
  content generation, pgvector semantic search/RAG, an MCP tool surface, and durable
  enrich/moderate agents that run in-process for dev and on **Temporal** (the `agent-worker`) in
  production — behind one `AgentRuntime` interface, so the workflow logic is shared, not duplicated.
- **Multi-tenant by construction.** Every operation carries a `Scope` of `{ spaceId, environmentId }`;
  a single database and cache serve many isolated spaces and branch-like environments.

---

## Documentation

Detailed docs live in [`docs/`](./docs):

| Doc | What's in it |
| --- | --- |
| [Architecture](./docs/architecture.md) | The hexagonal layers, the dependency rule, package map, request/event flows |
| [Domain model](./docs/domain-model.md) | Field types, validation, entry state machine, locales, references, assets, events |
| [API reference](./docs/api-reference.md) | Every HTTP endpoint, query language, hybrid search, Live Content SSE |
| [Auth & RBAC](./docs/auth-and-rbac.md) | API key kinds, scopes, custom roles, the `authorize` decision |
| [AI, agents & search](./docs/ai-agents-and-search.md) | Generation, hybrid search, MCP tools, agent runtime (enrich/moderate/curate/repurpose) |
| [Events & webhooks](./docs/events-and-webhooks.md) | Outbox→relay→dispatch, functions, scheduled actions, Live Content |
| [SDKs](./docs/sdks.md) | Delivery clients (core, web, edge, react-native) and email connector |
| [Deployment](./docs/deployment.md) | Docker, docker-compose (admin + override), Helm chart, per-cloud values |
| [Configuration](./docs/configuration.md) | The full environment-variable reference |
| [Development](./docs/development.md) | Workspace commands, testing, schema, adding a use-case |
| [Admin UI](./docs/admin-ui.md) | Management SPA at `:5173`, compose HMR, local dev workflow |
| [Benchmarking](./docs/benchmarking.md) | Content-at-scale load testing: `SEED_SCALE` + the k6 suite in `bench/k6/` |

For Claude Code specifically, see [`CLAUDE.md`](./CLAUDE.md).

---

## Repository layout

```
packages/
  domain/                   framework-agnostic core: content types, fields, entry publish
                            state machine, validation, RBAC, locales, domain events
  ports/                    interfaces only — ContentStore (DB seam) + infra/AI seams
  application/              use-cases orchestrating domain + ports over an AppContext
  agent-runtime/            engine-agnostic durable agents (enrich/moderate) + workflow logic
  graphql-gen/              builds a GraphQL Delivery schema from published content types
  test-kit/                 in-memory ContentStore + deterministic clock/id/blob/vector fakes
  adapters/
    store-postgres/         Drizzle schema + repos + committed SQL migrations
    redis/                  delivery cache (tag invalidation) + BullMQ queue
    blob-s3/                presigned S3/R2/GCS/MinIO/Azure uploads & downloads
    ai-anthropic/           Anthropic Claude AIProvider (default)
    ai-azure-openai/        Azure OpenAI AIProvider + EmbeddingsProvider
    vector-pgvector/        pgvector VectorStore (HNSW cosine)
  sdk/
    core/                   framework-agnostic Delivery client
    web/                    React hooks over the core client
    edge/                   tiny single-locale client for IoT/kiosks
    react-native/           offline sync hooks for React Native
    email/                  ESP connector (Mailchimp) for repurpose flows
apps/
  api/                      Hono Management + Delivery + Preview APIs; composition root in wire.ts
  worker/                   outbox relay + event dispatch + optional enrich agent
  agent-worker/             Temporal worker hosting durable agent workflows
  mcp-server/               stateless streamable-HTTP MCP server for AI agents
  migrator/                 Drizzle migration runner (K8s Job)
  admin/                    React management SPA (compose/local dev; not in Helm yet)
infra/
  helm/contentworker/       cloud-agnostic Helm chart + per-cloud values (aws/gcp/azure/local)
```

**The dependency rule:** `domain` → (nothing); `application` → `domain` + `ports`; `adapters`
→ `ports`; only `apps/*` bind concrete adapters to ports. IDs are **UUIDv7** (time-ordered →
sequential Postgres PK inserts, good B-tree locality), always minted via the injected
`IdGenerator`.

---

## Quick start

Requires **Node ≥ 22** and **pnpm 10**.

```bash
pnpm install

# Run the full test + typecheck suite
pnpm -r test
pnpm -r --filter '!@cw/migrator' run typecheck
pnpm lint

# Boot the API on an in-memory store (no Postgres/Redis needed)
pnpm --filter @cw/api start            # http://localhost:8787
```

In in-memory mode the store is seeded with space `space-1`, environment `main`, locale
`en-US`, and these dev tokens: `dev-cma-key` (write), `dev-cda-key` (delivery read),
`dev-cpa-key` (preview read), `dev-admin-token` (all scopes, all spaces).

### Against Postgres + Redis

```bash
export DATABASE_URL=postgres://localhost:5432/contentworker
export REDIS_URL=redis://localhost:6379
pnpm --filter @cw/migrator start                       # apply migrations
pnpm --filter @cw/api start &                           # serve the APIs
pnpm --filter @cw/worker start                          # relay outbox + dispatch events
```

### Whole stack in Docker

```bash
docker compose up --build                               # Postgres + Redis + migrator + api + worker
# API → http://localhost:8787
```

---

## End-to-end example

Model a content type, author an entry, publish, and read it back over the Delivery API:

```bash
B=http://localhost:8787
M=$B/spaces/space-1/environments/main
CMA='-H Authorization:Bearer dev-cma-key -H Content-Type:application/json'

# Define + publish a content type
curl -s -X POST $M/content-types $CMA -d '{
  "apiId":"article","name":"Article","displayField":"title",
  "fields":[{"apiId":"title","name":"Title","type":"Symbol","localized":false,"required":true,"position":0}]}'
curl -s -X POST $M/content-types/article/published -H 'Authorization: Bearer dev-cma-key'

# Author, publish, deliver
curl -s -X POST $M/entries $CMA -d '{"contentTypeApiId":"article","fields":{"title":{"en-US":"Hello"}}}'
curl -s -X POST $M/entries/<id>/published -H 'Authorization: Bearer dev-cma-key'
curl -s $B/delivery/space-1/main/entries/<id> -H 'Authorization: Bearer dev-cda-key'
```

The same operations are available as MCP tools (`entries_create`, `entries_publish`, …) so an
AI agent drives the CMS through the identical use-cases. See
[AI, agents & search](./docs/ai-agents-and-search.md).

---

## Status & roadmap

The end-to-end spine works: model → author → publish → deliver, with localization, references,
assets, RBAC, async event dispatch, webhooks, semantic search, REST **and GraphQL** delivery, AI
generation, the MCP server, and the agent runtime (in-process plus a **Temporal** agent-worker)
in place, plus a Helm chart for multi-cloud deployment.

Phased plan: P0–P1 tracer-bullet slice · P2 platform width (locales, field types, RBAC, Preview)
· P3 assets + references · P4 async backbone (BullMQ, outbox relay, webhooks) · P5 search +
GraphQL · P6–P8 the AI agentic layer (MCP, generation, pgvector RAG, Temporal agents) · P9
channel SDKs · P10 Helm + multi-cloud.

**P11–P18 — complete ✅.** The breadth phases on top of that spine: P11 field-level delivery query
language (filters/order/projection/full-text) · P12 scheduled publishing + atomic releases with a
perspective param · P13 editorial workflow, tasks, comments, roles/teams · P14 structured rich text
+ taxonomy (concepts/tags) · P15 version history (diff/restore), environment aliases & branch
compare/merge, audit log · P16 image-transform pipeline + asset metadata, usage tracking, AI
alt-text/auto-tagging · P17 the AI Content OS (full generation suite, governed AI Actions framework,
content semantics + duplicate detection, audit/curate/repurpose agents) · P18 extensibility & real-time
(streaming Live Content API, event-triggered Functions, App Framework UI extensions, Bulk API).

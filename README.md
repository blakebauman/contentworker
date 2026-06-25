# contentworker

A composable, **API-first, AI-agentic-first** headless CMS — like Contentful. Write
structured content once, deliver it anywhere (web, mobile, wearables/kiosks/IoT, email).
Built **cloud-agnostic** for Kubernetes (EKS/GKE/AKS) on a strict **ports & adapters**
core, so swapping clouds is a config change, not a code change.

Full architecture and the phased roadmap live in
[the plan](/Users/blake/.claude/plans/like-contentful-design-and-melodic-glade.md).

## What's built (P0 + P1 — the tracer-bullet vertical slice)

The end-to-end spine works: **model a content type → author an entry → publish →
read it back** over the Delivery API, with the publish writing a denormalized read
model and appending an `entry.published` event to a transactional outbox.

```
packages/
  domain/                 framework-agnostic core: content types, fields, entry
                          publish state machine, field validation, domain events
  ports/                  interfaces only — ContentStore + infra/AI seams
  application/            use-cases orchestrating domain + ports
  test-kit/               in-memory ContentStore + deterministic clock/id fakes
  adapters/store-postgres/ Drizzle schema + repos + generated SQL migration
apps/
  api/                    Hono Management + Delivery APIs; composition root (wire.ts)
  migrator/               drizzle migrate runner (K8s Job)
```

**The dependency rule:** `domain` depends on nothing; `application` on domain + ports;
adapters on ports; only `apps/*` bind concrete adapters to ports (in `apps/api/src/wire.ts`).
Every capability — and later the MCP tools, generation, and agents — calls the *same*
use-cases, so an AI agent can never do something a human API client can't.

IDs are **UUIDv7** (time-ordered → sequential Postgres PK inserts, good B-tree locality).

## Run it

```bash
pnpm install

# Run the full test + typecheck suite
pnpm -r test
pnpm -r --filter '!@cw/migrator' run typecheck   # migrator has no test target

# Boot the API on an in-memory store (no Postgres needed)
pnpm --filter @cw/api start            # http://localhost:8787

# Against Postgres: generate/apply migrations, then point the API at it
export DATABASE_URL=postgres://localhost:5432/contentworker
pnpm --filter @cw/adapter-store-postgres generate   # SQL is committed under drizzle/
pnpm --filter @cw/migrator start
DATABASE_URL=$DATABASE_URL pnpm --filter @cw/api start
```

### Example flow

```bash
B=http://localhost:8787
M=$B/spaces/space-1/environments/master
CMA='-H Authorization:Bearer dev-cma-key -H Content-Type:application/json'

# Define + publish a content type
curl -s -X POST $M/content-types $CMA -d '{
  "apiId":"article","name":"Article","displayField":"title",
  "fields":[{"apiId":"title","name":"Title","type":"Symbol","localized":false,"required":true,"position":0}]}'
curl -s -X POST $M/content-types/article/published -H 'Authorization: Bearer dev-cma-key'

# Author, publish, deliver
curl -s -X POST $M/entries $CMA -d '{"contentTypeApiId":"article","fields":{"title":{"en-US":"Hello"}}}'
curl -s -X POST $M/entries/<id>/published -H 'Authorization: Bearer dev-cma-key'
curl -s $B/delivery/space-1/master/entries/<id> -H 'Authorization: Bearer dev-cda-key'
```

## Roadmap

P2 platform width (locales, full field types, RBAC, Preview) · P3 assets + references ·
P4 async backbone (BullMQ, outbox relay, webhooks) · P5 search + GraphQL · P6–P8 the AI
agentic layer (MCP server, generation, pgvector RAG, Temporal agents) · P9 channel SDKs ·
P10 Helm + multi-cloud. See the plan for details.

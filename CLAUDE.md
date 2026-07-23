# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`contentworker` is an API-first, AI-agentic-first headless CMS.
It is a pnpm + Turborepo monorepo built on **strict ports & adapters (hexagonal)**
architecture, designed to be cloud-agnostic on Kubernetes. The full design and the
phased roadmap (P0–P10) live in the project plans directory under `~/.claude/plans/`.

## Commands

Package manager is **pnpm** (`pnpm@10.33.2`, Node ≥22). Turbo orchestrates `build`/`test`/`typecheck`.

```bash
pnpm install
pnpm -r test                                            # all tests (vitest)
pnpm -r --filter '!@cw/migrator' run typecheck          # migrator has no typecheck/test target
pnpm lint                                                # biome check .
pnpm format                                              # biome format --write .

# Run one package's tests, or a single test file / test name:
pnpm --filter @cw/application test
pnpm --filter @cw/application test -- p8-auth.test.ts
pnpm --filter @cw/application test -- -t 'name of test'

# Postgres adapter contract tests are opt-in (skipped unless a migrated DB is set):
TEST_DATABASE_URL=postgres://localhost:5432/contentworker_test \
  pnpm --filter @cw/adapter-store-postgres test

# Boot the API on an in-memory store (no Postgres/Redis needed):
pnpm --filter @cw/api start                             # http://localhost:8787
pnpm --filter @cw/api dev                               # same, with --watch

# Against real infra:
export DATABASE_URL=postgres://localhost:5432/contentworker
pnpm --filter @cw/adapter-store-postgres generate       # drizzle-kit: regenerate SQL after schema.ts changes
pnpm --filter @cw/migrator start                        # apply migrations
DATABASE_URL=$DATABASE_URL REDIS_URL=redis://localhost:6379 pnpm --filter @cw/worker start

# Full local stack (Postgres + Redis + migrator + api + worker):
docker compose up --build                               # API on :8787
```

Dev auth tokens (in-memory mode): `dev-cma-key` (write), `dev-cda-key` (delivery read),
`dev-cpa-key` (preview read), `dev-admin-token` (all scopes, all spaces).

## Architecture

The codebase is organized strictly by the **dependency rule** — dependencies point inward,
and only `apps/*` may bind concrete adapters to ports:

- **`packages/domain`** (`@cw/domain`) — framework-agnostic core. Depends on *nothing*.
  Content types, fields, the entry publish **state machine** (`entry/entry.ts`:
  `deriveStatus`/`saveDraft`/`publish`/`unpublish`), field validation, RBAC (`auth/auth.ts`:
  `SCOPES`, `scopesForKind`, `authorize`), and domain events.
- **`packages/ports`** (`@cw/ports`) — **interfaces only**, no implementations.
  - `content-store.ts`: the single DB seam (`ContentStore` + per-aggregate repos +
    `withTransaction` + transactional `outbox`). No SQL/ORM/driver type ever crosses it.
  - `infra.ts`: async/AI seams (`Queue`, `EventBus`, `BlobStore`, `Cache`, `WebhookSender`,
    `AIProvider`, `EmbeddingsProvider`, `VectorStore`). Defined from day one even before adapters exist.
  - `support.ts`: `Clock`, `IdGenerator`, `Hasher` — keep use-cases deterministic/testable.
- **`packages/application`** (`@cw/application`) — use-cases that orchestrate domain + ports.
  Every use-case takes an `AppContext` (`context.ts`: `store`, `clock`, `ids`, optional `cache`).
  One file per capability (entries, publishing, delivery, preview, assets, webhooks, rag,
  generation, auth, events/relay, events/dispatch).
- **`packages/adapters/*`** — concrete port implementations: `store-postgres` (Drizzle),
  `redis` (cache + BullMQ queue), `blob-s3`, `ai-anthropic`, `ai-azure-openai`, `vector-pgvector`,
  `http-effects` (webhook sender + function invoker), and the Cloudflare set:
  `queue-cf` (Queues producer), `cache-kv` (tag-versioned KV), `vector-vectorize`.
- **`packages/test-kit`** (`@cw/test-kit`) — in-memory `ContentStore`, fake blob/vector/embeddings,
  deterministic clock/id fakes. This is what makes the app layer testable without infra.
- **`apps/*`** — the only place adapters are bound to ports (the **composition root**):
  - `api` — Hono Management + Delivery + Preview APIs. `wire.ts` is the composition root.
  - `worker` — outbox relay loop + event dispatch (webhooks, cache invalidation, RAG embedding,
    enrich agent). `main.ts` is its composition root.
  - `mcp-server` — stateless streamable-HTTP MCP server; `wire.ts` is its composition root.
  - `migrator` — runs Drizzle migrations as a K8s Job (plus the pgvector schema;
    `SKIP_PGVECTOR=true` opts out).
  - `edge` — the whole platform as **one Cloudflare Worker** (API + admin assets + MCP +
    queue consumer + cron + `LiveHubDO` SSE hub + `AgentWorkflow` on Cloudflare Workflows),
    on Neon via Hyperdrive. `wire.ts`/`main.ts` are its composition roots; see `docs/cloudflare.md`.

**Key invariant:** the MCP tools, generation, and agents all call the *same* application
use-cases as the HTTP API — so an AI agent can never do something a human API client can't.
When adding a capability, add the use-case in `@cw/application` and expose it through both surfaces.

### Cross-cutting conventions

- **IDs are UUIDv7** — time-ordered for sequential Postgres PK inserts / B-tree locality.
  Always generate via the injected `IdGenerator` (`ctx.ids.newId()`), never `crypto.randomUUID()`/`uuidv4`.
- **Time** comes from `ctx.clock.now()`, never `new Date()` directly in use-cases.
- **Multi-tenancy by construction:** every store/use-case operation carries a `Scope`
  (`{ spaceId, environmentId }`). An environment is a branch within a space.
- **Localized values:** field values are `LocalizedValue` (`locale -> value`); non-localized
  fields still use this shape under the default locale, keeping read/write paths uniform.
- **Publish writes a denormalized read model** (`putPublished`) *and* appends a domain event to the
  **transactional outbox** in the same `withTransaction`, guaranteeing the event is enqueued iff the
  commit succeeds. The worker relays the outbox onto the queue and dispatches it.
- **AI callers pick a `ModelTier`** (`flagship` | `balanced` | `fast`), not a concrete model;
  the adapter maps tier→model. Anthropic is the default `AIProvider`; Azure OpenAI is swappable.
  Embeddings are a separate port (`EmbeddingsProvider`) since Anthropic ships no embeddings API.
- **Auth:** API keys are stored only as SHA-256 hashes; `principalMiddleware` resolves a bearer
  token to a `Principal`, and `requireScope`/`authorize` enforce RBAC scopes per route, checked
  against the route's `:space`. The admin token short-circuits to a wildcard (`spaceId: '*'`) principal.
  Granular RBAC: keys may bind a custom `Role` (live-resolved) whose `ContentTypeGrant`s add
  per-content-type read/write/publish checks and per-field deny/read-only rules
  (`authorizeContent`/`maskDeniedFields`/`assertWritableFields` in `domain/auth`).

### Adapter selection is env-driven (12-factor)

The same image runs anywhere; `apps/*/wire.ts` (and `worker/main.ts`) choose adapters from env:
- `DATABASE_URL` set → Postgres store; unset → seeded in-memory store (dev/tests/demos).
- `REDIS_URL` set → Redis cache + BullMQ queue (worker invalidates cache on publish).
- `BLOB_BUCKET` set → S3 blob store; unset → fake.
- `AI_PROVIDER` / `EMBEDDINGS_PROVIDER` (`anthropic` default / `azure-openai`).
- `ROLE` (`all` | `management` | `delivery` | `preview`) gates which API modules mount.
- Agents: `AGENTS_ENRICH=true` / `AGENTS_MODERATE=true` enable the on-publish agents;
  `AGENTS_AUTO_APPLY` toggles auto-apply vs. human-in-the-loop review.

### Agent runtime

`@cw/agent-runtime` runs durable agent workflows (`enrich`, `moderate`) behind an
engine-agnostic `AgentRuntime` facade. Side effects live behind the `Activities` interface, so the
*same* workflow code runs `InProcessAgentRuntime` (dev/tests/single-node, non-durable) or, in
production, under Temporal where each `Activities` method becomes a Temporal Activity
(see `packages/agent-runtime/temporal.md`). Don't put side effects directly in workflow functions.

## Conventions for new code

- **TypeScript is strict** (`tsconfig.base.json`): `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `verbatimModuleSyntax`, `isolatedModules`. Use **type-only imports** (`import type`) — Biome
  enforces `useImportType` as an error. ESM only (`"type": "module"`, `.js` import specifiers).
- **Biome** formats: single quotes, semicolons, trailing commas, 2-space indent, width 100.
  `noExplicitAny` is a warning; `drizzle/**` is excluded from linting.
- **Postgres schema changes:** edit `packages/adapters/store-postgres/src/schema.ts`, then run the
  package's `generate` script. The generated SQL under `drizzle/` is committed — don't hand-edit it.
- When adding a use-case, thread `Scope` through, take `AppContext`, and add a test in
  `packages/application/test/` using `@cw/test-kit` fakes. Test files are named for the capability
  under test (e.g. `releases.test.ts`, `query.test.ts`), not for a roadmap phase.

## Claude Code workflow

Project skills (in `.claude/skills/`): `/new-use-case` (scaffold a capability end-to-end),
`/review-arch` (dependency-rule + dual-surface review), `/db-migrate` (schema.ts → generate →
inspect SQL), `/ops-check` (helm/compose/CI/env-var parity), `/run-stack` (boot + smoke-test),
`/test-one` (single package/file/test), `/release-preflight` (local CI parity),
`/update-docs` (sync docs/ with the code).
Before committing non-trivial changes, run the review agents (`hexagonal-guardian`,
`code-reviewer`, `test-coverage-reviewer`); ops work goes to `ops-engineer` / `db-migration-agent`;
after a feature lands, `docs-keeper` keeps `docs/` truthful.
Hooks auto-format edited TS with Biome, block hand-edits to `drizzle/`, and flag convention drift.

## Design context

The admin UI's design context lives in `PRODUCT.md` (register, users, brand personality,
anti-references, design principles) and `DESIGN.md` (visual system: tokens, typography,
components, named rules). Read both before designing or restyling any `apps/admin` surface;
new screens must compose the existing token/component system, never stock shadcn defaults.
(`.impeccable/` is local design-tooling state and stays untracked.)

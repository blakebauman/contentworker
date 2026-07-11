# Development

## Prerequisites

- **Node ≥ 22**
- **pnpm 10** (`corepack enable` will provision it)

The repo is a pnpm workspace orchestrated by Turborepo. Packages are referenced by their `@cw/*`
names.

## Common commands

```bash
pnpm install

# Test / typecheck / lint everything
pnpm -r test
pnpm -r --filter '!@cw/migrator' run typecheck    # migrator has no typecheck/test target
pnpm lint                                          # biome check .
pnpm format                                        # biome format --write .
pnpm build                                         # turbo run build (tsup per package)

# One package
pnpm --filter @cw/application test
pnpm --filter @cw/domain typecheck

# A single test file or test name (vitest)
pnpm --filter @cw/application test -- auth.test.ts
pnpm --filter @cw/application test -- -t 'publishes an entry'
```

## Running locally

```bash
# In-memory (no infra): seeded space-1/main, dev tokens
pnpm --filter @cw/api start          # http://localhost:8787
pnpm --filter @cw/api dev            # same, with --watch
pnpm --filter @cw/mcp-server start   # http://localhost:8788/mcp

# With Postgres + Redis
export DATABASE_URL=postgres://localhost:5432/contentworker
export REDIS_URL=redis://localhost:6379
pnpm --filter @cw/migrator start
pnpm --filter @cw/api start
pnpm --filter @cw/worker start

# Whole stack (Postgres + Redis + migrator + api + worker + admin)
docker compose up --build

# Admin SPA only (API must already be running)
pnpm --filter @cw/admin dev          # http://localhost:5173

# Agent worker (when AGENT_RUNTIME=temporal)
pnpm --filter @cw/agent-worker start
```

The mcp-server ships smoke scripts under `apps/mcp-server/scripts/` (`smoke.mjs`,
`search-smoke.mjs`) that exercise the tool surface end-to-end.

Postgres adapter contract tests are opt-in:

```bash
TEST_DATABASE_URL=postgres://localhost:5432/contentworker_test \
  pnpm --filter @cw/adapter-store-postgres test
```

Apply migrations first with `pnpm --filter @cw/migrator start`.

## Conventions

- **Strict TypeScript** (`tsconfig.base.json`): `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters`, `verbatimModuleSyntax`, `isolatedModules`. ESM only (`"type": "module"`,
  `.js` import specifiers even from `.ts` sources).
- **Type-only imports** must use `import type` — Biome enforces `useImportType` as an error.
- **Biome** formatting: single quotes, semicolons, trailing commas, 2-space indent, width 100.
  `noExplicitAny` is a warning. `dist/`, `node_modules/`, `.turbo/`, and `drizzle/` are ignored.
- **IDs**: always mint via `ctx.ids.newId()` (UUIDv7) — never `crypto.randomUUID()` / `uuidv4`.
- **Time**: always `ctx.clock.now()` — never `new Date()` inside use-cases. This keeps tests
  deterministic.
- **Scope everything**: thread `{ spaceId, environmentId }` through every store/use-case call.

## Adding a use-case

1. Add the function to the right module in `packages/application/src/` (or a new module exported
   from `index.ts`). It takes `AppContext` (plus any extra deps like `RagDeps`/`BlobStore`) and a
   `Scope`.
2. Put pure rules (state transitions, validation) in `packages/domain` — keep the application
   layer orchestration-only.
3. If it needs a new persistence capability, add a method to the relevant port in
   `packages/ports`, then implement it in **both** `@cw/adapter-store-postgres` and the test-kit
   in-memory store.
4. Write a test in `packages/application/test/<capability>.test.ts` using `@cw/test-kit` fakes —
   no real infra required (e.g. `releases.test.ts`, `auth.test.ts`).
5. Expose it where it belongs: an HTTP route in `apps/api/src/routes/*`, an MCP tool in
   `apps/mcp-server/src/server.ts`, or an event handler in the worker. Reuse the **same**
   function across surfaces so validation and RBAC stay centralized.

## Changing the database schema

1. Edit `packages/adapters/store-postgres/src/schema.ts`.
2. Regenerate SQL: `pnpm --filter @cw/adapter-store-postgres generate` (drizzle-kit).
3. Commit the generated migration under `drizzle/` — **do not hand-edit** generated SQL.
4. Apply with the migrator (`pnpm --filter @cw/migrator start`).

## Postgres schema reference

Multi-tenancy is encoded as `(spaceId, environmentId)` in the PK or a unique index of every
content table. Core and platform tables:

| Table | Key | Purpose |
| --- | --- | --- |
| `spaces` | `id` | Space config: name, default_locale, locales, fallbacks |
| `environments` | `(spaceId, id)` | Branches within a space |
| `environment_aliases` | `(spaceId, alias)` | Resolve `:env` path segments (e.g. blue/green) |
| `content_types` | `(spaceId, environmentId, apiId)` | Content-type definitions (`fields` JSONB) |
| `entries` | `(spaceId, environmentId, id)` | Entry aggregate: status, versions |
| `entry_versions` | `(spaceId, environmentId, entryId, version)` | Immutable version ledger |
| `entry_published` | `(spaceId, environmentId, entryId)` | Denormalized published read model (+ FTS index) |
| `entry_metadata` | `(spaceId, environmentId, entryId)` | Tags and taxonomy concept associations |
| `assets` / `asset_published` | per-aggregate PK | Asset metadata (+ `metadata` JSONB for alt text/tags) |
| `references` | composite PK | Link graph; reverse index on `toId` |
| `api_keys` | `id` | Hashed tokens; optional `role_id` |
| `roles` | `(spaceId, id)` | Custom RBAC roles with `content_grants` |
| `webhooks` / `webhook_deliveries` | per-table | Subscriptions and delivery audit |
| `releases` / `release_items` | per-table | Release bundles |
| `scheduled_actions` | `id` | Deferred publish/unpublish |
| `comments` / `tasks` | `id` | Entry collaboration |
| `workflow_definitions` / `entry_workflow_state` | per-table | Editorial workflows |
| `concept_schemes` / `concepts` / `tags` | per-table | Controlled vocabulary |
| `ai_actions` | `id` | Configurable AI prompt templates |
| `functions` | `id` | User-defined HTTP hooks on events |
| `app_extensions` | `id` | iframe panel registrations for the admin |
| `agent_runs` | `id` | Agent execution audit ledger |
| `audit_log` | `id` | Space-level audit trail |
| `outbox` | `id` | Transactional outbox |

The pgvector adapter additionally manages `content_embeddings` — see
[AI, agents & search](./ai-agents-and-search.md).

Migrations `0000`–`0018` (19 files): `0000` init, `0001` fallbacks, `0002` references,
`0003` webhooks, `0004` api keys, `0005` assets, `0006` agent runs, `0007` api key name
nullable, `0008` releases + scheduled actions, `0009` comments/workflows/tasks,
`0010` taxonomy + entry metadata, `0011` environment aliases, `0012` audit log,
`0013` asset metadata, `0014` ai actions, `0015` functions, `0016` app extensions,
`0017` FTS index on `entry_published`, `0018` roles + `api_keys.role_id`.

## Testing approach

The application layer is tested against `@cw/test-kit` fakes — an in-memory `ContentStore`, fake
blob/vector/embeddings, and deterministic `Clock`/`IdGenerator`. Tests are named for the
capability under test (e.g. `releases.test.ts`, `query.test.ts`) and run with vitest. Because the
fakes implement the same ports as the real adapters, a passing application test exercises the real
use-case logic end-to-end without infra.

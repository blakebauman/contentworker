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
pnpm --filter @cw/application test -- p8-auth.test.ts
pnpm --filter @cw/application test -- -t 'publishes an entry'
```

## Running locally

```bash
# In-memory (no infra): seeded space-1/master, dev tokens
pnpm --filter @cw/api start          # http://localhost:8787
pnpm --filter @cw/api dev            # same, with --watch
pnpm --filter @cw/mcp-server start   # http://localhost:8788/mcp

# With Postgres + Redis
export DATABASE_URL=postgres://localhost:5432/contentworker
export REDIS_URL=redis://localhost:6379
pnpm --filter @cw/migrator start
pnpm --filter @cw/api start
pnpm --filter @cw/worker start

# Whole stack
docker compose up --build
```

The mcp-server ships smoke scripts under `apps/mcp-server/scripts/` (`smoke.mjs`,
`search-smoke.mjs`) that exercise the tool surface end-to-end.

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
4. Write a test in `packages/application/test/pN-*.test.ts` using `@cw/test-kit` fakes — no real
   infra required.
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
content table. Tables:

| Table | Key | Purpose |
| --- | --- | --- |
| `spaces` | `id` | Space config: name, default_locale, locales, fallbacks |
| `environments` | `(spaceId, id)` | Branches within a space |
| `content_types` | `(spaceId, environmentId, apiId)` | Content-type definitions (`fields` as JSONB), version, status |
| `entries` | `(spaceId, environmentId, id)` | Entry aggregate: status, currentVersion, publishedVersion |
| `entry_versions` | `(spaceId, environmentId, entryId, version)` | Immutable version ledger (`fields` JSONB) |
| `entry_published` | `(spaceId, environmentId, entryId)` | Denormalized published read model; index by content type |
| `assets` | `(spaceId, environmentId, id)` | Asset metadata (`file`/`title`/`description` JSONB) |
| `asset_published` | `(spaceId, environmentId, assetId)` | Denormalized published assets |
| `references` | `(spaceId, environmentId, fromEntryId, fromField, toId)` | Link graph; reverse index on `toId` |
| `api_keys` | `id` | Hashed tokens; unique index on `hashedToken`, index by space |
| `webhooks` | `id` | Subscriptions: url, topics, secret, headers |
| `webhook_deliveries` | identity | Delivery audit log |
| `outbox` | `id` | Transactional outbox; partial index on `relayedAt IS NULL` |

The pgvector adapter additionally manages a self-initializing `content_embeddings` table
(`(spaceId, environmentId, entryId, locale, chunkIndex)` PK, HNSW cosine index) — see
[AI, agents & search](./ai-agents-and-search.md).

Migrations `0000`–`0005`: `0000` init (spaces, environments, content_types, entries,
entry_versions, entry_published, outbox), `0001` space fallbacks, `0002` references, `0003`
webhooks, `0004` api keys, `0005` assets.

## Testing approach

The application layer is tested against `@cw/test-kit` fakes — an in-memory `ContentStore`, fake
blob/vector/embeddings, and deterministic `Clock`/`IdGenerator`. Tests are organized by phase
(`pN-*.test.ts`) and run with vitest. Because the fakes implement the same ports as the real
adapters, a passing application test exercises the real use-case logic end-to-end without infra.

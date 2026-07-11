---
name: db-migrate
description: Postgres schema change workflow — edit schema.ts, drizzle generate, inspect SQL, verify with contract tests
argument-hint: "<what to change>"
---

Perform the schema change: $ARGUMENTS

Everything under `packages/adapters/store-postgres/drizzle/` is drizzle-kit output — a hook
blocks hand-edits. The workflow is always schema.ts → generate → inspect → verify.

1. Read `packages/adapters/store-postgres/src/schema.ts` and the newest `drizzle/00NN_*.sql`
   to understand the current shape.
2. Edit `src/schema.ts` (and `src/store.ts` if the row mapping changes). Invariants:
   - Tenant-scoped tables carry `space_id` + `environment_id`, with indexes leading on them.
   - PKs are UUIDv7 — no serial/identity columns.
   - Outbox table shape is load-bearing for the worker relay; if touched, check `apps/worker`.
3. Generate: `pnpm --filter @cw/adapter-store-postgres generate`
4. **STOP: read the newly generated `drizzle/00NN_*.sql` and show it to the user**, calling
   out every destructive statement (`DROP`, `ALTER ... TYPE`, data-losing defaults). Do not
   apply anything until the user confirms.
5. After confirmation, verify against a disposable DB (`docker compose up -d postgres`):
   - `DATABASE_URL=postgres://localhost:5432/contentworker_test pnpm --filter @cw/migrator start`
   - `TEST_DATABASE_URL=postgres://localhost:5432/contentworker_test pnpm --filter @cw/adapter-store-postgres test`
6. Commit guidance: `src/schema.ts`, the new SQL, and `drizzle/meta/` go in **one commit**.
   If the change needs a new port method, keep ORM/driver types out of `@cw/ports` and add the
   in-memory implementation to `@cw/test-kit`.

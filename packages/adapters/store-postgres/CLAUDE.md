# store-postgres adapter

- Everything under `drizzle/` is drizzle-kit output — generated **and committed**, never
  hand-edited (a repo hook blocks it). Workflow: edit `src/schema.ts` →
  `pnpm --filter @cw/adapter-store-postgres generate` → inspect the new SQL (call out
  destructive statements) → commit schema.ts + SQL + `drizzle/meta/` together.
- Contract tests are opt-in: they auto-skip unless `TEST_DATABASE_URL` points at a migrated
  database (`DATABASE_URL=... pnpm --filter @cw/migrator start` to migrate).
- No ORM/driver type may cross into `@cw/ports` signatures — port methods speak domain types
  only; the mapping lives here in `src/store.ts`.
- Tenant-scoped tables carry `space_id` + `environment_id` with indexes leading on them;
  PKs are UUIDv7.

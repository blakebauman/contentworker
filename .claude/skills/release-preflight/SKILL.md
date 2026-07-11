---
name: release-preflight
description: Full CI parity locally — lint, helm lint, typecheck (excl migrator), all tests, admin build
context: fork
allowed-tools: Read, Grep, Glob, Bash
---

Replicate `.github/workflows/ci.yml` locally, in order, failing fast:

1. `pnpm lint`
2. `helm dependency update infra/helm/contentworker && helm lint infra/helm/contentworker`
3. `pnpm -r --filter '!@cw/migrator' run typecheck`
4. `pnpm -r test`
   - If `TEST_DATABASE_URL` / `TEST_REDIS_URL` are unset, the Postgres/Redis contract suites
     auto-skip: note this in the report and include the enable command
     (`docker compose up -d postgres redis`, then export both vars — DB
     `postgres://localhost:5432/contentworker_test` migrated via
     `DATABASE_URL=... pnpm --filter @cw/migrator start`).
5. `pnpm --filter @cw/admin build`

Output: a step | status (PASS/FAIL/SKIPPED-partial) table, then the first failing step's
output verbatim. If everything passes, state plainly that the branch matches CI green.

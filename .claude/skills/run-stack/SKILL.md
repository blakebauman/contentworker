---
name: run-stack
description: Boot the local stack (in-memory or docker) and smoke-test the API with dev keys
argument-hint: "[memory|docker] (default memory)"
---

Mode: $ARGUMENTS (default `memory`).

## memory mode (no Postgres/Redis — seeded in-memory store)

1. Start in the background (never foreground a server): `pnpm --filter @cw/api start`
2. Wait for http://localhost:8787 to answer.

## docker mode (full stack: postgres + redis + migrator + api + worker + admin)

1. `docker compose up --build -d`
2. Wait for the api healthcheck on :8787 (admin serves on :5173).

## Smoke tests (both modes)

Dev tokens: `dev-cma-key` (management write), `dev-cda-key` (delivery read),
`dev-cpa-key` (preview read), `dev-admin-token` (all scopes, all spaces).

1. Delivery read with `Authorization: Bearer dev-cda-key` — expect 200 with seeded content.
2. Management write probe with `dev-cma-key` — expect success; then confirm the same request
   with `dev-cda-key` is rejected (scope enforcement).
3. Admin wildcard: one management call with `dev-admin-token` — expect 200.

Discover concrete routes from `apps/api/src` if unsure — don't guess URL shapes.
Report each probe: method, path, token, status, and a one-line verdict.

## Teardown

- memory: kill the background api process.
- docker: `docker compose down` (add `-v` only if the user wants data wiped).

---
name: new-use-case
description: Scaffold a new application capability — use-case, test, API route, MCP tool, wiring checklist
argument-hint: "<capability-name> [short description]"
---

Scaffold the capability: $ARGUMENTS

Follow this checklist in order. The core invariant: an AI agent must never be able to do
something a human API client can't — every capability is one application use-case exposed
through **both** surfaces.

1. **Study the closest analogous capability first.** Pick the most similar file in
   `packages/application/src/` (and its test in `packages/application/test/`) and mirror its
   structure, naming, and error handling. Do not invent new patterns.

2. **Use-case** — `packages/application/src/<capability>.ts`:
   - Exported functions take `(ctx: AppContext, scope: Scope, input)` — thread `Scope`
     (`{ spaceId, environmentId }`) into every store call.
   - Current time via `ctx.clock.now()`; IDs via `ctx.ids.newId()` (UUIDv7).
   - Mutations inside `ctx.store.withTransaction`; if the capability emits a domain event,
     append it to the outbox **in the same transaction**.
   - Pure business rules (validation, state transitions) belong in `@cw/domain`, called from
     the use-case — not inline.

3. **Test** — `packages/application/test/<capability>.test.ts` (named by capability, never a
   `pN-` roadmap prefix), using `@cw/test-kit` fakes. Include at minimum: the happy path, a
   failure path, and a **two-Scope isolation test** (data written under one scope invisible
   under another). If it publishes, assert the outbox event.

4. **Dual-surface exposure**:
   - Hono route in `apps/api` with `requireScope`/`authorize` RBAC checked against the
     route's `:space` — thin: authorize, parse, call the use-case, serialize.
   - MCP tool in `apps/mcp-server` calling the *same* use-case — equally thin.

5. **New ports (only if needed)**: add the interface to `@cw/ports` (interfaces only, domain
   types only — no ORM/driver types), the in-memory implementation to `@cw/test-kit`, and the
   Postgres implementation to `store-postgres`. For schema changes, delegate to the
   `db-migration-agent` (or run `/db-migrate`).

6. **Verify**: `pnpm --filter @cw/application test -- <capability>.test.ts`, then
   `pnpm --filter @cw/application typecheck` plus the touched apps. Finish by recommending
   `/review-arch` on the result.

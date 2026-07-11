# contentworker documentation

These docs describe how contentworker is built and how to run, extend, and integrate with it.

## Contents

1. **[Architecture](./architecture.md)** — the hexagonal layers, the dependency rule, the
   package map, and how a request and an event flow through the system.
2. **[Domain model](./domain-model.md)** — field types, the validation engine, the entry
   publish state machine, localization & fallback, references, assets, platform aggregates,
   and domain events.
3. **[API reference](./api-reference.md)** — every Management, Delivery, and Preview HTTP
   endpoint, the shared query language, hybrid search, Live Content SSE, and error mapping.
4. **[Auth & RBAC](./auth-and-rbac.md)** — API key kinds (CMA/CDA/CPA), permission scopes,
   custom roles, principals, the admin token, and the `authorize` decision.
5. **[AI, agents & search](./ai-agents-and-search.md)** — AI content generation, hybrid /
   semantic search, the MCP tool surface (~50 tools), and the enrich/moderate/curate/repurpose
   agent runtime.
6. **[Events & webhooks](./events-and-webhooks.md)** — the transactional outbox, relay loop,
   dispatch (webhooks, cache, RAG, functions), scheduled actions, Live Content, and agent hooks.
7. **[SDKs](./sdks.md)** — Delivery clients (`@cw/sdk-core`, web, edge, react-native) and the
   email connector (`@cw/sdk-email`).
8. **[Deployment](./deployment.md)** — Docker, docker-compose (including admin + override),
   and the cloud-agnostic Helm chart with per-cloud (AWS/GCP/Azure/local) values.
9. **[Configuration](./configuration.md)** — the complete environment-variable reference.
10. **[Development](./development.md)** — workspace commands, testing, conventions, schema
    reference, and how to add a new use-case.
11. **[Admin UI](./admin-ui.md)** — the management SPA at `:5173`, compose override HMR, and
    local dev workflow.

## Conventions used in these docs

- **Scope** means `{ spaceId, environmentId }` — the multi-tenant boundary carried through
  every operation. An *environment* is a branch within a *space* (e.g. `main`, `staging`).
- **CMA / CDA / CPA** are the Content Management / Delivery / Preview API key kinds.
- Paths shown like `/spaces/:space/environments/:env/...` use `:param` for path segments.
- **`…`** abbreviates `/spaces/:space/environments/:env` in Management API tables.

# contentworker documentation

These docs describe how contentworker is built and how to run, extend, and integrate with it.

## Contents

1. **[Architecture](./architecture.md)** — the hexagonal layers, the dependency rule, the
   package map, and how a request and an event flow through the system.
2. **[Domain model](./domain-model.md)** — field types, the validation engine, the entry
   publish state machine, localization & fallback, references, assets, and domain events.
3. **[API reference](./api-reference.md)** — every Management, Delivery, and Preview HTTP
   endpoint, with method, path, required scope, request/response shape, and error mapping.
4. **[Auth & RBAC](./auth-and-rbac.md)** — API key kinds (CMA/CDA/CPA), permission scopes,
   principals, the admin token, and the `authorize` decision.
5. **[AI, agents & search](./ai-agents-and-search.md)** — AI content generation, RAG /
   semantic search, the MCP tool surface, and the enrich/moderate agent runtime.
6. **[Events & webhooks](./events-and-webhooks.md)** — the transactional outbox, the relay
   loop, event dispatch, webhook signing & delivery, and cache invalidation.
7. **[SDKs](./sdks.md)** — the core Delivery client, the React hooks (web), and the edge client.
8. **[Deployment](./deployment.md)** — Docker, docker-compose, and the cloud-agnostic Helm
   chart with per-cloud (AWS/GCP/Azure/local) values.
9. **[Configuration](./configuration.md)** — the complete environment-variable reference.
10. **[Development](./development.md)** — workspace commands, testing, conventions, and how to
    add a new use-case.

## Conventions used in these docs

- **Scope** means `{ spaceId, environmentId }` — the multi-tenant boundary carried through
  every operation. An *environment* is a branch within a *space* (e.g. `master`, `staging`).
- **CMA / CDA / CPA** are the Content Management / Delivery / Preview API key kinds, mirroring
  Contentful's split.
- Paths shown like `/spaces/:space/environments/:env/...` use `:param` for path segments.

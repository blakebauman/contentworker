# Architecture

contentworker is a **ports & adapters (hexagonal)** monorepo. The guiding constraint is the
**dependency rule**: dependencies point inward, toward the domain, and infrastructure is bound
only at the edges.

```
            ┌──────────────────────────────────────────────────────────┐
            │                        apps/*                             │
            │   api   ·   worker   ·   mcp-server   ·   migrator        │
            │   (composition roots: bind adapters → ports)              │
            └───────────────┬───────────────────────┬──────────────────┘
                            │ uses                   │ binds
                            ▼                        ▼
          ┌─────────────────────────┐     ┌──────────────────────────────┐
          │   packages/application  │     │      packages/adapters/*      │
          │   use-cases over ports  │     │  store-postgres · redis ·     │
          │   (AppContext)          │     │  blob-s3 · ai-anthropic ·     │
          └───────────┬─────────────┘     │  ai-azure-openai · vector-pg  │
                      │ depends on        └───────────────┬──────────────┘
            ┌─────────┴──────────┐                        │ implement
            ▼                    ▼                        ▼
   ┌─────────────────┐   ┌──────────────────────────────────────────────┐
   │ packages/domain │   │              packages/ports                   │
   │ (depends on     │◀──│  ContentStore (DB seam) + infra/AI seams +    │
   │  nothing)       │   │  support (Clock, IdGenerator, Hasher)         │
   └─────────────────┘   └──────────────────────────────────────────────┘
```

## The layers

### `packages/domain` — the core

Pure, framework-agnostic TypeScript that depends on **nothing**. It owns:

- **Content types & fields** — the structured-content schema and its 11 field types.
- **The entry publish state machine** — `deriveStatus`, `saveDraft`, `publish`, `unpublish`,
  `archive`, as pure functions over immutable aggregates.
- **Validation** — `validateEntryFields` / `assertEntryFieldsValid`, the single source of truth
  for both human and AI writes.
- **Locales** — fallback-chain resolution.
- **References** — `extractReferences` over link fields.
- **Assets, webhooks, events** — value types and small state transitions.
- **RBAC** — `SCOPES`, `scopesForKind`, `authorize`, `inScope`, and the `Principal` type.
- **Errors** — `DomainError` and subclasses with stable `code`s.

See [Domain model](./domain-model.md).

### `packages/ports` — the interfaces

Interfaces only; **no implementations**. Three files:

- `content-store.ts` — the **single database seam**. `ContentStore` exposes per-aggregate repos
  (`spaces`, `contentTypes`, `entries`, `assets`, `references`, `webhooks`, `auth`, `outbox`)
  and `withTransaction`. No SQL, ORM, or driver type ever crosses this boundary.
- `infra.ts` — async & AI seams: `Queue`, `EventBus`, `BlobStore`, `Cache`, `WebhookSender`,
  `AIProvider`, `EmbeddingsProvider`, `VectorStore`. Defined from day one even before adapters
  existed, so the application could be written against them.
- `support.ts` — `Clock`, `IdGenerator`, `Hasher`, which keep use-cases deterministic and
  testable.

### `packages/application` — the use-cases

Functions that orchestrate the domain over the ports. Every use-case takes an `AppContext`:

```ts
interface AppContext {
  readonly store: ContentStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly cache?: Cache;   // optional delivery cache
}
```

One module per capability: `content-types`, `entries`, `publishing`, `delivery`, `preview`,
`assets`, `webhooks`, `generation`, `rag`, `render`, `spaces`, `auth`, plus `events/relay` and
`events/dispatch`. These modules are the **only** way state changes — the HTTP API, the MCP
server, and the worker all call them.

### `packages/adapters/*` — the implementations

Each adapter implements one or more ports against a concrete technology. They are interchangeable:
the Postgres store and the in-memory test store both implement `ContentStore`; Anthropic and
Azure OpenAI both implement `AIProvider`. See [Deployment](./deployment.md) for the full list.

### `packages/test-kit` — deterministic fakes

In-memory `ContentStore`, fake `BlobStore`, in-memory `VectorStore`, a local
`EmbeddingsProvider`, and deterministic `Clock`/`IdGenerator`. This is what lets the application
layer be tested with zero infrastructure (`packages/application/test/pN-*.test.ts`).

### `apps/*` — composition roots

The only place adapters are bound to ports. Each app has a `wire.ts` (or `main.ts`) that reads
environment variables and selects adapters:

- **`api`** — the Hono HTTP server (Management + Delivery + Preview). `ROLE` gates which modules
  mount. `wire.ts` builds the `AppContext`, RAG deps, and blob store.
- **`worker`** — runs the outbox relay loop and consumes the events queue, dispatching to
  webhooks, cache invalidation, RAG indexing, and (optionally) the enrich agent.
- **`agent-worker`** — a Temporal worker hosting the durable `enrich`/`moderate` workflows on the
  `contentworker-agents` task queue (the production agent executor).
- **`mcp-server`** — a stateless streamable-HTTP MCP server exposing the use-cases as tools.
- **`migrator`** — runs Drizzle migrations (a Kubernetes Job / compose one-shot).

Two supporting packages sit alongside these: **`packages/agent-runtime`** holds the engine-agnostic
workflow logic and the in-process executor, and **`packages/graphql-gen`** builds a GraphQL
Delivery schema from published content types (consumed by the API's `/graphql` route).

## The key invariant: one set of use-cases, three callers

```
   HTTP client ──▶ apps/api ─────┐
   AI agent ─────▶ apps/mcp-server ─▶  packages/application use-cases  ─▶ ports ─▶ adapters
   events ───────▶ apps/worker ───┘
```

Because the API routes, the MCP tools, and the worker all funnel through the same application
functions, the platform has a single enforcement point for validation and RBAC. **An AI agent
can never do something a human API client can't** — both go through `createEntry`, `publishEntry`,
etc., which validate fields against the content model and authorize the principal's scopes.

## Multi-tenancy by construction

Every store and use-case operation carries a `Scope` of `{ spaceId, environmentId }`. A *space*
is a tenant boundary; an *environment* is a branch within it (e.g. `main`, `staging`). In
Postgres, `(spaceId, environmentId)` is part of the primary key or a unique index on every
content table, so one database serves many isolated spaces without row-level security.

## Request flow (write → deliver)

1. A client `POST`s to the Management API with a CMA bearer token.
2. `principalMiddleware` resolves the token (admin short-circuit, else hashed-key lookup) to a
   `Principal`; `requireScope` authorizes it against the route's `:space`.
3. The route calls an application use-case (e.g. `publishEntry`).
4. The use-case runs inside `store.withTransaction`: it writes the denormalized **published read
   model** and appends a **domain event to the outbox** — atomically.
5. The worker relays the outbox event to the queue and dispatches it: webhooks fire, delivery
   cache tags are invalidated, vectors are re-indexed.
6. A Delivery client `GET`s the published entry with a CDA token; reads hit the denormalized read
   model (and the Redis cache when configured).

See [Events & webhooks](./events-and-webhooks.md) for the async half in detail.

## Why these choices

- **Ports & adapters** keep the domain testable and the cloud swappable — changing object store
  or AI provider is a wiring change in one `wire.ts`, not a refactor.
- **UUIDv7 IDs** are time-ordered, giving sequential Postgres PK inserts and good B-tree
  locality. They're always minted through the injected `IdGenerator`, never `crypto.randomUUID`.
- **Transactional outbox** guarantees an event is enqueued **iff** its state change commits — no
  lost events, no phantom events.
- **Denormalized read models** (`entry_published`, `asset_published`) make Delivery reads a
  single-row lookup, decoupled from the version ledger.

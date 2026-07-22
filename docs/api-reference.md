# HTTP API reference

> **Interactive docs:** every deployment serves its own OpenAPI 3.1 spec at
> `GET /openapi.json` (a complete inventory of the mounted routes — the spec
> reflects the deployment's `ROLE`) and a browsable Scalar UI at `GET /docs`.

The API is a [Hono](https://hono.dev) server (`apps/api`) exposing three role-based surfaces:

- **Management (CMA)** — authoring, publishing, space administration, AI, releases, workflows.
- **Delivery (CDA)** — read-only published content, hybrid search, Live Content SSE, GraphQL.
- **Preview (CPA)** — read-only draft/current content.

Which surfaces mount is controlled by `ROLE` (see [Configuration](./configuration.md)):

| `ROLE` | Mounted |
| --- | --- |
| `all` (default) | Management + Delivery + Preview |
| `management` | Management only |
| `delivery` | Delivery only |
| `preview` | Preview only |

## Authentication

Every endpoint except `/healthz`, `/readyz`, and `/graphiql/:space/:env` requires
`Authorization: Bearer <token>`.

1. If the token equals the configured **admin token**, the request gets a wildcard admin
   `Principal` (`spaceId: '*'`, all CMA scopes) — used for provisioning/bootstrap.
2. Otherwise the token is SHA-256 hashed and looked up as an API key; the matched key's space,
   scopes, and optional role grants become the `Principal`.
3. An unknown/missing token → **401**.

Each route then calls `requireScope(scope)`, which runs `authorize(principal, scope, :space)`.
Delivery and Preview list/get endpoints additionally filter by granular `contentGrants` when the
key is role-bound. See [Auth & RBAC](./auth-and-rbac.md).

## Environment aliases

Path segment `:env` in Management, Delivery, and Preview routes is resolved through
**environment aliases** (`environment_aliases` table) before use. This supports blue/green-style
routing without changing client URLs.

## System endpoints

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/healthz` | none | `{ "status": "ok" }` |
| GET | `/readyz` | none | `{ "status": "ready", "role": "<role>" }` |
| GET | `/graphiql/:space/:env` | none | GraphiQL HTML shell (queries still need a CDA token) |

---

## Shared query language

Delivery and Preview entry list endpoints, and GraphQL resolvers, share the query parser in
`apps/api/src/query.ts`. In addition to `content_type`, `locale`, `limit`, `skip`, `since`, and
`include`:

| Parameter | Syntax | Meaning |
| --- | --- | --- |
| Field filter | `fields.<apiId>=v` | Equals |
| Field filter (op) | `fields.<apiId>[op]=v` | `op` ∈ `ne`, `in`, `nin`, `gt`, `gte`, `lt`, `lte`, `exists`, `match` |
| System field | `sys.publishedAt[gt]=<iso>` | Filter on `sys.*` pseudo-fields |
| Sort | `order=fields.title,-sys.publishedAt` | Comma-separated; `-` prefix = descending |
| Projection | `select=fields.title,fields.body` | Return only listed field apiIds |
| Full-text | `query=foo` | FTS over string fields (published model on Delivery) |

---

## Management API (CMA)

Base paths: `/spaces` and `…` = `/spaces/:space/environments/:env`.

### Spaces & environments

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/spaces` | auth | List spaces (admin: all; scoped key: own space) |
| POST | `/spaces` | `space:admin` | Create a space |
| GET | `/spaces/:space/environments` | `preview:read` | List environments |
| POST | `/spaces/:space/environments` | `space:admin` | Create environment `{ id, name }` |
| GET | `/spaces/:space/environment-aliases` | `preview:read` | List aliases |
| PUT | `/spaces/:space/environment-aliases/:alias` | `space:admin` | Set alias → environment id |
| DELETE | `/spaces/:space/environment-aliases/:alias` | `space:admin` | Remove alias |
| GET | `/spaces/:space/audit-log` | `space:admin` | Space audit log (`?limit`, `?skip`) |
| GET | `/spaces/:space/compare` | `preview:read` | Compare two environments (`?from`, `?to`) |
| POST | `/spaces/:space/merge` | `content:manage` | Merge environment branch |

### API keys & roles

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/spaces/:space/api-keys` | `space:admin` | List keys |
| POST | `/spaces/:space/api-keys` | `space:admin` | Mint key (`kind`, optional `roleId`) — raw `token` once |
| DELETE | `/spaces/:space/api-keys/:id` | `space:admin` | Revoke key |
| GET | `/spaces/:space/roles` | `space:admin` | List roles |
| POST | `/spaces/:space/roles` | `space:admin` | Create role |
| GET | `/spaces/:space/roles/:id` | `space:admin` | Get role |
| PUT | `/spaces/:space/roles/:id` | `space:admin` | Update role |
| DELETE | `/spaces/:space/roles/:id` | `space:admin` | Delete role (refused if keys bound) |

### Space config & content types

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/space-config` | `preview:read` | Space settings for the environment |
| GET | `…/content-types` | `preview:read` | List content types |
| POST | `…/content-types` | `content:manage` | Create/update content type |
| GET | `…/content-types/:apiId` | `preview:read` | Get one |
| POST | `…/content-types/:apiId/published` | `content:publish` | Publish definition |

### Entries — CRUD & publishing

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| POST | `…/entries` | `content:write` | Create draft `{ contentTypeApiId, fields }` |
| GET | `…/entries/:id` | `preview:read` | Get current entry (RBAC-filtered fields) |
| PUT | `…/entries/:id` | `content:write` | Save new draft version |
| POST | `…/entries/:id/published` | `content:publish` | Publish |
| DELETE | `…/entries/:id/published` | `content:publish` | Unpublish |
| GET | `…/entries/:id/reverse-references` | `preview:read` | Entries linking to this one |

### Entries — AI & semantics

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| POST | `…/entries/generate` | `content:write` | Generate draft fields from prompt |
| POST | `…/entries/canvas` | `content:write` | Multi-field canvas generation |
| POST | `…/entries/:id/translate` | `content:write` | Translate fields to locales |
| POST | `…/entries/:id/summarize` | `content:write` | Summarize entry text |
| POST | `…/entries/:id/autofill` | `content:write` | Fill empty fields |
| POST | `…/entries/:id/suggest-tags` | `content:write` | Suggest taxonomy tags |
| POST | `…/entries/:id/audit` | `content:write` | AI content audit |
| POST | `…/entries/:id/moderate` | `content:write` | Run moderation agent |
| GET | `…/entries/:id/related` | `search:read` | Semantically related entries |
| GET | `…/entries/:id/duplicates` | `search:read` | Near-duplicate detection |
| GET | `…/entries/:id/embedding` | `search:read` | Embedding vector metadata |

### Entries — versioning & bulk

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/entries/:id/versions` | `preview:read` | Version list |
| GET | `…/entries/:id/versions/diff` | `preview:read` | Diff two versions (`?from`, `?to`) |
| GET | `…/entries/:id/versions/:version` | `preview:read` | Get specific version |
| POST | `…/entries/:id/versions/:version/restore` | `content:write` | Restore version as new draft |
| POST | `…/bulk/entries` | `content:write` | Bulk create/update |
| POST | `…/bulk/entries/publish` | `content:publish` | Bulk publish |
| POST | `…/bulk/entries/unpublish` | `content:publish` | Bulk unpublish |

### Entry metadata & taxonomy associations

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/entries/:id/metadata` | `preview:read` | Tags + concepts on entry |
| PUT | `…/entries/:id/metadata` | `content:write` | Set tags/concepts |

### Assets

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/assets` | `preview:read` | List assets |
| POST | `…/assets` | `content:write` | Create draft + presigned upload URL |
| GET | `…/assets/:id` | `preview:read` | Get asset |
| PATCH | `…/assets/:id/metadata` | `content:write` | Update alt text / tags metadata |
| GET | `…/assets/:id/usage` | `preview:read` | Reference usage |
| GET | `…/assets/:id/transform` | `preview:read` | Image transform URL |
| POST | `…/assets/:id/alt-text` | `content:write` | AI alt-text generation |
| POST | `…/assets/:id/auto-tag` | `content:write` | AI auto-tagging |
| POST | `…/assets/:id/published` | `content:publish` | Publish asset |
| DELETE | `…/assets/:id/published` | `content:publish` | Unpublish asset |

### Releases

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/releases` | `preview:read` | List releases |
| POST | `…/releases` | `content:write` | Create release |
| GET | `…/releases/:id` | `preview:read` | Get release |
| DELETE | `…/releases/:id` | `content:write` | Delete draft release |
| POST | `…/releases/:id/items` | `content:write` | Add entity to release |
| DELETE | `…/releases/:id/items/:entityId` | `content:write` | Remove item |
| POST | `…/releases/:id/published` | `content:publish` | Publish release bundle |

### Scheduled actions

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/scheduled-actions` | `preview:read` | List scheduled publish/unpublish |
| POST | `…/scheduled-actions` | `content:publish` | Schedule action |
| DELETE | `…/scheduled-actions/:id` | `content:publish` | Cancel scheduled action |

### Agent schedules

Recurring agent jobs (cron-cadence workflow runs over newly-published entries) — see
[AI, agents & search](./ai-agents-and-search.md#agent-schedules).

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/agent-schedules` | `preview:read` | List recurring agent jobs |
| POST | `…/agent-schedules` | `content:publish` | Create schedule `{ workflow, cron (5-field UTC), contentTypeApiId?, enabled?, autoApply? }` |
| PATCH | `…/agent-schedules/:id` | `content:publish` | Update cron / enabled / autoApply / content-type filter |
| DELETE | `…/agent-schedules/:id` | `content:publish` | Delete schedule |

### Agent reviews

Human-in-the-loop decisions on agent proposals — see
[AI, agents & search](./ai-agents-and-search.md#human-in-the-loop-reviews).

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/agent-reviews` | `preview:read` | List reviews (`?status=pending`, `?entryId=`) |
| POST | `…/agent-reviews/:id/approve` | `content:write` | Approve: applies the proposal exactly once (or signals the durable watcher) |
| POST | `…/agent-reviews/:id/reject` | `content:write` | Reject: nothing is applied |

### Collaboration

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/entries/:id/comments` | `preview:read` | List comments |
| POST | `…/entries/:id/comments` | `content:write` | Add comment |
| DELETE | `…/comments/:id` | `content:write` | Delete comment |
| GET | `…/entries/:id/tasks` | `preview:read` | List tasks |
| POST | `…/entries/:id/tasks` | `content:write` | Create task |
| PUT | `…/tasks/:id` | `content:write` | Update task status/assignee |
| DELETE | `…/tasks/:id` | `content:write` | Delete task |

### Workflows

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/workflows` | `preview:read` | List workflow definitions |
| POST | `…/workflows` | `content:manage` | Define workflow |
| GET | `…/workflows/:id` | `preview:read` | Get workflow |
| DELETE | `…/workflows/:id` | `content:manage` | Delete workflow |
| GET | `…/entries/:id/workflow` | `preview:read` | Entry workflow state |
| POST | `…/entries/:id/workflow/transition` | `preview:read` | Transition step (step scope enforced in use-case) |

### Taxonomy

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/taxonomy/schemes` | `preview:read` | List concept schemes |
| POST | `…/taxonomy/schemes` | `content:manage` | Create scheme |
| DELETE | `…/taxonomy/schemes/:id` | `content:manage` | Delete scheme |
| GET | `…/taxonomy/concepts` | `preview:read` | List concepts (`?scheme`) |
| POST | `…/taxonomy/concepts` | `content:manage` | Create concept |
| PUT | `…/taxonomy/concepts/:id/broader` | `content:manage` | Set broader concept |
| DELETE | `…/taxonomy/concepts/:id` | `content:manage` | Delete concept |
| GET | `…/taxonomy/tags` | `preview:read` | List tags |
| POST | `…/taxonomy/tags` | `content:manage` | Create tag |
| DELETE | `…/taxonomy/tags/:id` | `content:manage` | Delete tag |

### Platform configuration

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/functions` | `preview:read` | List event-triggered HTTP functions |
| POST | `…/functions` | `content:manage` | Register function |
| DELETE | `…/functions/:id` | `content:manage` | Delete function |
| GET | `…/app-extensions` | `preview:read` | List admin iframe extensions |
| POST | `…/app-extensions` | `content:manage` | Register extension |
| DELETE | `…/app-extensions/:id` | `content:manage` | Delete extension |
| GET | `…/ai-actions` | `preview:read` | List AI action templates |
| POST | `…/ai-actions` | `content:manage` | Create AI action |
| DELETE | `…/ai-actions/:id` | `content:manage` | Delete AI action |
| POST | `…/ai-actions/:id/run` | `content:write` | Run AI action on an entry |
| GET | `…/agent-runs` | `space:admin` | List agent run audit records |
| GET | `…/agent-runs/usage` | `space:admin` | Token usage aggregates |

### Webhooks

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/webhooks` | `space:admin` | List webhooks |
| POST | `…/webhooks` | `space:admin` | Create webhook |
| PUT | `…/webhooks/:id` | `space:admin` | Update webhook |
| DELETE | `…/webhooks/:id` | `space:admin` | Delete webhook |
| GET | `…/webhooks/:id/deliveries` | `space:admin` | Delivery log |

---

## Delivery API (CDA)

Base path: `/delivery/:space/:env`. Reads the denormalized **published** read model (Redis cache
when configured). List/get responses apply granular RBAC when the key is role-bound.

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/delivery/:space/:env/entries` | `delivery:read` | List published entries |
| GET | `/delivery/:space/:env/entries/:id` | `delivery:read` | Get one published entry |
| GET | `/delivery/:space/:env/assets` | `delivery:read` | List published assets |
| GET | `/delivery/:space/:env/assets/:id` | `delivery:read` | Get one published asset |
| GET | `/delivery/:space/:env/search` | `search:read` | Search — **hybrid by default** |
| GET | `/delivery/:space/:env/live` | `delivery:read` | **SSE** Live Content stream |
| GET | `/delivery/:space/:env/assets/:id/transform` | `delivery:read` | Image transform redirect |
| GET/POST | `/delivery/:space/:env/graphql` | `delivery:read` | GraphQL Delivery endpoint |

**Common query parameters:** shared [query language](#shared-query-language) plus `locale`,
`include` (reference depth 0–5), `limit`, `skip`, `since` (delta sync).

**Search parameters:** `q` (required), `top_k`, `mode` = `hybrid` (default) | `semantic` |
`lexical`.

A delivered entry is `{ id, contentType, fields, publishedAt }`; with `?locale=` fields flatten to
that locale; with `?include=N` linked entries embed up to depth N (cycle-guarded).

### GraphQL Delivery

`ALL /delivery/:space/:env/graphql` serves a schema **generated from published content types** by
`@cw/graphql-gen`. Cached per `(space, environment)` keyed on content-type versions.

- Query via `?query=` (GET) or JSON body `{ query, variables?, operationName? }` (POST).
- Resolvers call the same use-cases as REST with locale flattening and link resolution.

### Live Content (SSE)

`GET /delivery/:space/:env/live` opens a Server-Sent Events stream. After domain events are
dispatched, the worker publishes them on the Redis `EventBus`; the API fans them out to connected
clients. Use for real-time cache invalidation or live previews on the read side.

---

## Preview API (CPA)

Base path: `/preview/:space/:env`. Reads **draft/current** versions. Supports the same
[query language](#shared-query-language) as Delivery. Granular RBAC applies on list/get.

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/preview/:space/:env/entries` | `preview:read` | List current entries |
| GET | `/preview/:space/:env/entries/:id` | `preview:read` | Get one current entry |

---

## Error handling

The `onError` middleware maps domain errors to HTTP responses. The body is always
`{ "error": { "code", "message", ... } }`.

| Error | Status | Body extras |
| --- | --- | --- |
| `NotFoundError` | 404 | — |
| `ValidationError` | 422 | `issues` (the `FieldIssue[]`) |
| `ConflictError` | 409 | — |
| `DomainError` code `unauthorized` | 401 | — |
| `DomainError` code `forbidden` | 403 | — |
| other `DomainError` | 400 | — |
| Hono `HTTPException` | its status | code `http_error` |
| anything else | 500 | code `internal`, generic message |

## Notes

- All write bodies are JSON; set `Content-Type: application/json`.
- Field values are always locale-keyed maps, e.g. `"fields": { "title": { "en-US": "Hello" } }`,
  even for non-localized fields (use the default locale).
- The same operations are exposed as **MCP tools** for AI agents — see
  [AI, agents & search](./ai-agents-and-search.md).
- The [Admin UI](./admin-ui.md) is a browser client of these Management endpoints.

# HTTP API reference

The API is a [Hono](https://hono.dev) server (`apps/api`) exposing three role-based surfaces:

- **Management (CMA)** — authoring, publishing, and space administration.
- **Delivery (CDA)** — read-only published content + semantic search.
- **Preview (CPA)** — read-only draft/current content.

Which surfaces mount is controlled by `ROLE` (see [Configuration](./configuration.md)):

| `ROLE` | Mounted |
| --- | --- |
| `all` (default) | Management + Delivery + Preview |
| `management` | Management only |
| `delivery` | Delivery only |
| `preview` | Preview only |

This lets you run one monolith or split the read-heavy Delivery surface onto its own
independently-scaled deployment.

## Authentication

Every endpoint except `/healthz` and `/readyz` requires `Authorization: Bearer <token>`.

1. If the token equals the configured **admin token**, the request gets a wildcard admin
   `Principal` (`spaceId: '*'`, all CMA scopes) — used for provisioning/bootstrap.
2. Otherwise the token is SHA-256 hashed and looked up as an API key; the matched key's space and
   scopes become the `Principal`.
3. An unknown/missing token → **401**.

Each route then calls `requireScope(scope)`, which runs `authorize(principal, scope, :space)` —
the principal must hold the scope **and** be in the route's space (admin `*` is in every space).
A failure → **403**. See [Auth & RBAC](./auth-and-rbac.md).

## System endpoints

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/healthz` | none | `{ "status": "ok" }` |
| GET | `/readyz` | none | `{ "status": "ready", "role": "<role>" }` |

---

## Management API (CMA)

Base paths: `/spaces` and `/spaces/:space/environments/:env`.

### Spaces & environments

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| POST | `/spaces` | `space:admin` | Create a space (body: id, name, defaultLocale, locales, fallbacks, environments) |
| POST | `/spaces/:space/environments` | `space:admin` | Create an environment — body `{ id, name }` |

### API keys

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/spaces/:space/api-keys` | `space:admin` | List keys → `{ items: ApiKey[] }` |
| POST | `/spaces/:space/api-keys` | `space:admin` | Mint a key — body includes `kind`. Returns `{ id, kind, token }`; the raw `token` is shown **once** (only its hash is stored) |

### Content types

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/content-types` | `preview:read` | List → `{ items: ContentType[] }` |
| POST | `…/content-types` | `content:manage` | Create/update a content type (body: apiId, name, displayField, fields[]) |
| GET | `…/content-types/:apiId` | `preview:read` | Get one |
| POST | `…/content-types/:apiId/published` | `content:publish` | Publish the definition (emits `content_type.published`) |

### Entries

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| POST | `…/entries` | `content:write` | Create a draft entry — body `{ contentTypeApiId, fields }`. Validated against the model |
| GET | `…/entries/:id` | `preview:read` | Get the current (draft) entry |
| PUT | `…/entries/:id` | `content:write` | Save a new draft version — body `{ fields }` |
| POST | `…/entries/:id/published` | `content:publish` | Publish (checks referential integrity; emits `entry.published`) |
| DELETE | `…/entries/:id/published` | `content:publish` | Unpublish (emits `entry.unpublished`) |

### Assets

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| POST | `…/assets` | `content:write` | Create a draft asset; returns metadata + a presigned upload `{ url, headers }` |
| GET | `…/assets/:id` | `preview:read` | Get an asset (draft or published) |
| POST | `…/assets/:id/published` | `content:publish` | Publish the asset |
| DELETE | `…/assets/:id/published` | `content:publish` | Unpublish the asset |

### Webhooks

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `…/webhooks` | `space:admin` | List → `{ items: Webhook[] }` |
| POST | `…/webhooks` | `space:admin` | Create — body `{ url, topics[], secret, active?, headers? }` |

> `…` abbreviates `/spaces/:space/environments/:env`.

---

## Delivery API (CDA)

Base path: `/delivery/:space/:env`. Reads the denormalized **published** read model (served from
the Redis cache when configured).

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/delivery/:space/:env/entries` | `delivery:read` | List published entries → `{ items, total }` |
| GET | `/delivery/:space/:env/entries/:id` | `delivery:read` | Get one published entry |
| GET | `/delivery/:space/:env/assets` | `delivery:read` | List published assets → `{ items, total }` |
| GET | `/delivery/:space/:env/assets/:id` | `delivery:read` | Get one published asset |
| GET | `/delivery/:space/:env/search` | `search:read` | Semantic search → `{ hits: SearchHit[] }` |
| GET/POST | `/delivery/:space/:env/graphql` | `delivery:read` | GraphQL Delivery endpoint (see below) |

**Query parameters**

- Entries: `content_type` (filter by apiId), `locale` (flatten to one locale with fallback),
  `include` (reference-embedding depth, 0–5), `limit`, `skip`.
- Single entry: `locale`, `include`.
- Assets: `limit`.
- Search: `q` (required), `top_k`.

A delivered entry is shaped `{ id, contentType, fields, publishedAt }`; with `?locale=` the
`fields` are flattened to that locale, and with `?include=N` linked entries are embedded up to
depth N (cycle-guarded).

### GraphQL Delivery

`ALL /delivery/:space/:env/graphql` (scope `delivery:read`) serves a GraphQL schema **generated
from your published content types** by `@cw/graphql-gen` — each content type becomes a GraphQL
object type, with root fields for single entries, collections, assets, and search. The schema is
cached per `(space, environment)` and keyed on the set of content-type `apiId@version`, so it
rebuilds automatically when the model changes.

- Send the query as `?query=` (GET) or a JSON body `{ query, variables?, operationName? }` (POST).
- Resolvers call the same use-cases as REST (`getPublishedEntry`, `listPublishedEntries`,
  `getPublishedAsset`, `semanticSearch`), with locale flattening and `include: 1` link resolution.
- A missing query → **400** `{ errors: [...] }`; GraphQL execution errors come back in the
  standard `{ data, errors }` envelope.

---

## Preview API (CPA)

Base path: `/preview/:space/:env`. Reads **draft/current** versions (for editor previews).

| Method | Path | Scope | Description |
| --- | --- | --- | --- |
| GET | `/preview/:space/:env/entries` | `preview:read` | List current entries → `{ items, total }` |
| GET | `/preview/:space/:env/entries/:id` | `preview:read` | Get one current entry |

**Query parameters:** `content_type`, `locale`.

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

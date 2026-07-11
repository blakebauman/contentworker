# Authentication & RBAC

Authorization is enforced in the domain (`packages/domain/src/auth`) and applied uniformly by
both the HTTP API and the MCP server — because both resolve a `Principal` and call the same
`authorize` function before invoking any use-case.

## API key kinds

The three key kinds (`ApiKeyKind`):

| Kind | Name | Purpose |
| --- | --- | --- |
| `cma` | Content Management API | Full authoring, publishing, and space admin |
| `cda` | Content Delivery API | Read published content + search |
| `cpa` | Content Preview API | Read draft/current content (+ published + search) |

## Permission scopes

`SCOPES` (`PermissionScope`):

| Scope | Grants |
| --- | --- |
| `content:write` | Create/update draft entries and assets; AI draft generation |
| `content:publish` | Publish/unpublish entries, assets, and content types |
| `content:manage` | Define/revise content-type schemas |
| `preview:read` | Read draft/current entries and content-type definitions |
| `delivery:read` | Read published entries and assets |
| `search:read` | Semantic search over published content |
| `space:admin` | Manage API keys, create spaces/environments, manage webhooks |

### Default scopes per kind

`scopesForKind(kind)`:

| Kind | Scopes |
| --- | --- |
| `cma` | **all seven** scopes |
| `cda` | `delivery:read`, `search:read` |
| `cpa` | `preview:read`, `delivery:read`, `search:read` |

A key may be minted with an explicit scope override; otherwise it receives its kind's defaults.

## Custom roles (granular RBAC)

A **role** is a named, space-scoped permission set assignable to API keys — the layer below
coarse scopes. It carries a scope set plus per-content-type grants:

```ts
interface Role {
  id: string;
  spaceId: string;
  name: string;
  description?: string;
  scopes: readonly string[];               // same vocabulary as SCOPES
  contentGrants: readonly ContentTypeGrant[];
}

interface ContentTypeGrant {
  contentTypeApiId: string;                // exact apiId, or '*' for all types
  actions: readonly ('read' | 'write' | 'publish')[];
  deniedFields?: readonly string[];        // masked on read, rejected on write
  readOnlyFields?: readonly string[];      // readable, rejected on write
}
```

Semantics:

- **Roles are live**: a role-bound key resolves the role's scopes and grants on **every**
  request (`authenticate`), so editing a role instantly changes what every bound key can do.
  Deleting a role is refused while active keys reference it; a dangling reference fails closed.
- **Exact grant wins over `'*'`**; a type with no matching grant is denied entirely.
- **Enforcement points** (identical for HTTP and MCP): entry create/update check
  `authorizeContent(principal, 'write', ct)` + `assertWritableFields`; publish/unpublish check
  the `publish` action; management/preview/delivery reads filter out ungranted types and
  `maskDeniedFields` on what remains. Keys without a role (`contentGrants === undefined`) are
  unrestricted at this layer — coarse scopes alone apply, preserving pre-role behavior.
- Managed at `GET/POST /spaces/:space/roles`, `GET/PUT/DELETE /spaces/:space/roles/:id`
  (requires `space:admin`) and the `roles_list` / `role_create` / `role_update` /
  `role_delete` MCP tools. Mint a bound key with `POST …/api-keys { kind, roleId }`.

Grants govern entry read/write/publish and content-type visibility. **Delivery and Preview**
list/get endpoints filter ungranted content types and `maskDeniedFields` on responses. Coarse
scopes still gate search, GraphQL, SSE, and assets at the route level.

## API keys at rest

```ts
interface ApiKey {
  id: string;
  spaceId: string;
  kind: ApiKeyKind;
  name: string;
  hashedToken: string;       // SHA-256 of the raw token — the raw token is NEVER stored
  scopes: readonly string[]; // display snapshot; role-bound keys resolve live from the role
  revoked: boolean;
  roleId?: string;           // custom role binding (granular RBAC)
}
```

The raw token is returned exactly once, at creation (`POST …/api-keys`). Authentication hashes
the presented bearer token and looks it up by hash (`AuthRepo.findByHash`).

## Principals

```ts
interface Principal {
  spaceId: string;                       // a specific space, or '*' for admin/root
  kind: ApiKeyKind | 'admin' | 'user';
  scopes: readonly string[];
  contentGrants?: readonly ContentTypeGrant[];  // from the key's role; undefined = unrestricted
  subject?: string;                      // OIDC subject/email when kind is `user`
  sessionId?: string;                    // session revocation id for OIDC users
}
```

- `authenticate(ctx, hasher, token)` resolves a bearer token to a `Principal`, throwing
  `UnauthorizedError` on miss.
- The **admin token** (`ADMIN_TOKEN` / `MCP_TOKEN`) short-circuits to a wildcard principal
  (`spaceId: '*'`, all CMA scopes). Use it only for provisioning/bootstrap.
- **`GET /auth/me`** returns the resolved principal summary (used by the admin connect UI).
- **Preview links** — `POST …/entries/:id/preview-link` mints an expiring token; CPA
  `GET …/entries/:id?preview_token=…` accepts it without a bearer header.
- **Admin SSO** — optional OIDC on `@cw/api` (`/auth/oidc/*`) mints delegated CMA keys bound to roles
  (see [Configuration](./configuration.md#admin-auth-oidc-sso-on-cwapi)).

## The authorization decision

```ts
inScope(principal, targetSpaceId): boolean
  // true if principal.spaceId === '*'  OR  principal.spaceId === targetSpaceId

authorize(principal, scope, targetSpaceId): void
  // throws ForbiddenError unless inScope(...) AND principal.scopes.includes(scope)
```

`authorize` is the single decision point. In the API, `requireScope(scope)` middleware extracts
the route's `:space` and calls it; in the MCP server, each tool calls it before delegating to a
use-case. A failure surfaces as **403** (`forbidden`); an unauthenticated request as **401**
(`unauthorized`).

## Scope → operation map

| Scope | Use-cases / endpoints (representative) |
| --- | --- |
| `content:write` | Entry/asset CRUD, AI generation endpoints, bulk writes, comments/tasks, metadata |
| `content:publish` | Publish/unpublish entries, assets, content types, releases; scheduled actions |
| `content:manage` | Content types, workflows, taxonomy, functions, app-extensions, ai-actions, merge |
| `preview:read` | Preview entries, content types, releases, workflows, collaboration reads |
| `delivery:read` | Published entries/assets, Live Content SSE, GraphQL |
| `search:read` | Hybrid/semantic search, related/duplicates/embedding |
| `space:admin` | Spaces, environments, aliases, API keys, roles, webhooks, audit log, agent runs |

`GET /spaces` returns all spaces for an admin principal (`spaceId: '*'`) or only the key's own
space for scoped keys.

## Dev credentials

In in-memory mode the store is seeded with keys whose raw tokens are the `CMA_KEY` / `CDA_KEY` /
`CPA_KEY` config values (defaults `dev-cma-key`, `dev-cda-key`, `dev-cpa-key`) and the
`ADMIN_TOKEN` (default `dev-admin-token`). These are seeded **through the real auth path** (hashed
and stored), so dev and production behave identically. Replace them in any real deployment.

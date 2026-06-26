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

## API keys at rest

```ts
interface ApiKey {
  id: string;
  spaceId: string;
  kind: ApiKeyKind;
  name: string;
  hashedToken: string;       // SHA-256 of the raw token — the raw token is NEVER stored
  scopes: readonly string[];
  revoked: boolean;
}
```

The raw token is returned exactly once, at creation (`POST …/api-keys`). Authentication hashes
the presented bearer token and looks it up by hash (`AuthRepo.findByHash`).

## Principals

```ts
interface Principal {
  spaceId: string;                       // a specific space, or '*' for admin/root
  kind: ApiKeyKind | 'admin';
  scopes: readonly string[];
}
```

- `authenticate(ctx, hasher, token)` resolves a bearer token to a `Principal`, throwing
  `UnauthorizedError` on miss.
- The **admin token** (`ADMIN_TOKEN` / `MCP_TOKEN`) short-circuits to a wildcard principal
  (`spaceId: '*'`, all CMA scopes). Use it only for provisioning/bootstrap.

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

| Scope | Use-cases / endpoints |
| --- | --- |
| `content:write` | `createEntry`, `updateEntry`, `createAsset`, `draftEntry` |
| `content:publish` | `publishEntry`, `unpublishEntry`, `publishAsset`, `unpublishAsset`, `publishContentType` |
| `content:manage` | `createContentType`, `updateContentType` |
| `preview:read` | `getPreviewEntry`, `listPreviewEntries`, `getContentType`, `listContentTypes` |
| `delivery:read` | `getPublishedEntry`, `listPublishedEntries`, published assets |
| `search:read` | `semanticSearch` |
| `space:admin` | `createApiKey`, `listApiKeys`, `createSpace`, `createEnvironment`, webhooks |

## Dev credentials

In in-memory mode the store is seeded with keys whose raw tokens are the `CMA_KEY` / `CDA_KEY` /
`CPA_KEY` config values (defaults `dev-cma-key`, `dev-cda-key`, `dev-cpa-key`) and the
`ADMIN_TOKEN` (default `dev-admin-token`). These are seeded **through the real auth path** (hashed
and stored), so dev and production behave identically. Replace them in any real deployment.

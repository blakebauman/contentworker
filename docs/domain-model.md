# Domain model

The domain layer (`packages/domain`) is pure TypeScript with no infrastructure dependencies. It
defines the structured-content model and the rules that govern it.

## Core scalar types

| Type | Shape | Notes |
| --- | --- | --- |
| `Scope` | `{ spaceId, environmentId }` | The multi-tenant boundary on every operation |
| `LocaleCode` | `string` | BCP-47, e.g. `"en-US"` |
| `LocalizedValue` | `Record<LocaleCode, unknown>` | A field value keyed by locale, e.g. `{ "en-US": "Hi", "de-DE": "Hallo" }` |
| `EntryFields` | `Record<string, LocalizedValue>` | All field values for an entry: `fieldApiId → locale → value` |
| `EntryStatus` | `'draft' \| 'changed' \| 'published' \| 'archived'` | Entry lifecycle |
| `ContentTypeStatus` | `'draft' \| 'published'` | Content-type lifecycle |

Non-localized fields still use `LocalizedValue` with a single entry under the space's default
locale, keeping the read/write paths uniform.

## Field types

A content type is an ordered list of typed, validated fields. The 11 field types
(`FIELD_TYPES`):

| Type | Represents | Stored value |
| --- | --- | --- |
| `Symbol` | Short single-line text | `string` |
| `Text` | Long multi-line text | `string` |
| `RichText` | Structured rich-text document | object |
| `Integer` | Whole number | integer |
| `Number` | Floating-point number | number |
| `Boolean` | True/false | boolean |
| `Date` | ISO-8601 date/time | string |
| `Location` | Geographic point | `{ lat: number, lon: number }` |
| `JSON` | Arbitrary JSON | object |
| `Link` | Reference to an Entry or Asset | `{ id, linkType }` |
| `Array` | Homogeneous list of `Symbol` or `Link` | array |

### Field definition

```ts
interface FieldDefinition {
  apiId: string;              // unique within the type; /[a-zA-Z][a-zA-Z0-9_]*/, ≤ 64 chars
  name: string;               // human-facing label
  type: FieldType;
  localized: boolean;         // may values differ per locale?
  required: boolean;
  position: number;           // ascending order within the type
  validations?: FieldValidations;
  linkType?: 'Entry' | 'Asset';   // for Link fields
  items?: {                       // for Array fields
    type: 'Symbol' | 'Link';
    linkType?: 'Entry' | 'Asset';
    validations?: FieldValidations;
  };
}
```

### Per-field validations

```ts
interface FieldValidations {
  in?: readonly (string | number)[];          // enumeration (Symbol/Text/Integer/Number)
  regexp?: { pattern: string; flags?: string }; // pattern match (Symbol/Text)
  range?: { min?: number; max?: number };      // numeric range, inclusive (Integer/Number)
  size?: { min?: number; max?: number };       // length (Symbol/Text) or item count (Array)
  linkContentTypes?: readonly string[];        // restrict Link targets to these content-type apiIds
}
```

## The validation engine

`validateEntryFields(contentType, fields, ctx)` returns a `FieldIssue[]` (empty when valid).
`assertEntryFieldsValid(...)` wraps it and throws `ValidationError` if any issue exists. This is
the **single validation path** for both human API writes and AI-generated content.

Rules applied:

1. **Unknown fields** — any key not in the content type is rejected.
2. **Required** — enforced on the default locale only; other locales resolve via fallback at
   delivery time.
3. **Type checks** — per the table above (string/integer/number/boolean/valid ISO date/`{lat,lon}`
   /object/`{id,linkType}`/array-of-items).
4. **Size** — `size.min`/`size.max` against string length or array item count.
5. **Range** — `range.min`/`range.max` against numeric value.
6. **Enumeration** — value must be in `validations.in`.
7. **Regex** — `Symbol`/`Text` must match `validations.regexp`.
8. **Localization** — non-localized fields must not carry values under non-default locales.

```ts
interface FieldIssue {
  field: string;     // field apiId ("" for entry-level issues)
  locale?: string;   // present when locale-specific
  message: string;
}
```

## Content type

```ts
interface ContentType {
  apiId: string;          // stable machine identifier
  name: string;
  displayField: string;   // apiId of the field used as the entry's display title
  fields: readonly FieldDefinition[];
  version: number;        // bumped on each revision
  status: 'draft' | 'published';
}
```

- `defineContentType(draft)` — validates the `apiId` and field set (no duplicate apiIds,
  `displayField` must exist), returns a `ContentType` at version 1, status `draft`. Throws
  `ValidationError` / `ConflictError`.
- `reviseContentType(current, changes)` — increments `version`, resets status to `draft`, sorts
  fields by `position`, optionally updates `name`/`displayField`/`fields`.

## Entry aggregate & state machine

```ts
interface Entry {
  id: string;
  contentTypeApiId: string;
  status: EntryStatus;
  currentVersion: number;           // latest saved draft snapshot
  publishedVersion: number | null;  // snapshot served by Delivery (if any)
}

interface EntryVersion {            // immutable point-in-time snapshot
  entryId: string;
  version: number;
  fields: EntryFields;
}
```

Status is **derived**, never set directly, by `deriveStatus(currentVersion, publishedVersion, archived)`:

| Condition | Status |
| --- | --- |
| `archived === true` | `archived` |
| `publishedVersion === null` | `draft` |
| `currentVersion > publishedVersion` | `changed` (published, with newer unpublished edits) |
| `currentVersion === publishedVersion` | `published` |

Transitions (pure functions; each throws `InvalidStateError` when its precondition fails):

| Function | Effect | Precondition |
| --- | --- | --- |
| `saveDraft(entry, fields)` | `currentVersion += 1`, new `EntryVersion`, re-derive status | not `archived` |
| `publish(entry)` | `publishedVersion = currentVersion`, status `published` | not `archived` |
| `unpublish(entry)` | `publishedVersion = null`, status `draft` | currently published |
| `archive(entry)` | status `archived` | — |

`currentVersion`/`publishedVersion` are pointers into the immutable version ledger; each
`saveDraft` appends a new version, and `publishedVersion` pins which one Delivery serves.

## Locales & fallback

```ts
interface LocaleConfig {
  defaultLocale: LocaleCode;
  locales: readonly LocaleCode[];
  fallbacks?: Record<LocaleCode, LocaleCode | null>;  // locale → fallback (null = stop)
}
```

- `fallbackChain(config, requested)` — builds an ordered chain (most specific first) by following
  fallback pointers, guards against cycles, and always ends at `defaultLocale`. E.g. with
  `fallbacks = { "fr-CA": "fr", "fr": null }`, requesting `fr-CA` yields `["fr-CA", "fr", default]`.
- `resolveLocalizedValue(value, config, requested)` — walks the chain and returns the first
  defined value.
- `resolveFieldsForLocale(fields, config, requested)` — flattens an entry's fields to a single
  locale with fallback applied; used by Delivery/Preview when `?locale=` is given.

## Assets

```ts
interface Asset {
  id: string;
  status: 'draft' | 'published' | 'archived';
  file: AssetFile;                 // { url, fileName, contentType, size?, width?, height? }
  title: LocalizedValue;
  description: LocalizedValue;
}
```

Assets have a single current revision (no version ledger). `publishAsset` / `unpublishAsset`
move between `draft` and `published` (throwing `InvalidStateError` on bad transitions). Bytes are
uploaded directly to object storage via a presigned URL — they never transit the API.

## References

```ts
interface ReferenceEdge {
  fromEntryId: string;
  fromField: string;            // the link field's apiId
  toId: string;                 // target entry/asset id
  toType: 'Entry' | 'Asset';
}
```

`extractReferences(fromEntryId, fields, contentType)` is a pure function that walks an entry's
`Link` and `Array`-of-`Link` fields across all locales and returns deduplicated edges. On publish,
edges are materialized so the platform can:

- enforce **referential integrity** (publishing fails if a linked entry/asset doesn't exist),
- **resolve links** in Delivery (`?include=` embedding), and
- **invalidate caches** in reverse — when X changes, entries embedding X are refreshed.

## Webhooks

```ts
interface Webhook {
  id: string;
  url: string;
  topics: readonly (EventType | '*')[];   // subscribed event types; "*" = all
  secret: string;                          // HMAC signing secret
  active: boolean;
  headers?: Record<string, string>;        // extra headers per delivery
}
```

`matchesTopic(webhook, type)` is true when the webhook is active and its topics include `*` or the
exact event type. Delivery attempts are recorded as `WebhookDelivery` rows for observability.

## Domain events

`DomainEvent` is a discriminated union appended to the transactional outbox. All share a
`BaseEvent` of `{ id, scope, occurredAt }`:

| `type` | Extra payload |
| --- | --- |
| `entry.published` | `entryId`, `contentTypeApiId`, `version`, `fields` |
| `entry.unpublished` | `entryId`, `contentTypeApiId` |
| `content_type.published` | `contentTypeApiId`, `version` |
| `release.published` | `releaseId`, `entryIds` |

`EventType = DomainEvent['type']`. The stable `id` makes dispatch idempotent.

## Platform aggregates

Beyond core content types and entries, the domain (and store) model several platform capabilities.
See [API reference](./api-reference.md) for HTTP shapes.

| Aggregate | Purpose |
| --- | --- |
| **Release** | Bundle entries/assets for coordinated publish (`release.published` event) |
| **ScheduledAction** | Deferred publish/unpublish at a future time |
| **Comment / Task** | Editorial collaboration on entries |
| **WorkflowDefinition** | Named steps with scope requirements; per-entry workflow state |
| **ConceptScheme / Concept / Tag** | Controlled vocabulary and free-form tags |
| **EntryMetadata** | Tags and concept associations on an entry |
| **Role / ContentTypeGrant** | Granular RBAC (see [Auth & RBAC](./auth-and-rbac.md)) |
| **AiAction** | Configurable prompt templates runnable against entries |
| **Function** | User-defined HTTP endpoint invoked on domain events |
| **AppExtension** | iframe panel registration for the admin UI |
| **AgentRun** | Audit record for agent workflow executions |
| **AuditLogEntry** | Space-level change audit |
| **EnvironmentAlias** | Map a path alias to a concrete environment id |

Asset `metadata` (alt text per locale, tags) lives on the asset aggregate as JSONB.

## RBAC types

See [Auth & RBAC](./auth-and-rbac.md) for the full model. The domain owns: the `SCOPES` map,
`scopesForKind(kind)`, the `Principal` type, and the `authorize` / `inScope` decisions.

## Errors

All extend `DomainError` (`{ code, message, details? }`) and carry a stable, client-facing `code`:

| Class | `code` | Meaning |
| --- | --- | --- |
| `NotFoundError(resource, id)` | `not_found` | Resource missing |
| `ValidationError(issues)` | `validation_failed` | Carries `issues: FieldIssue[]` |
| `ConflictError(message, details?)` | `conflict` | Uniqueness violation (e.g. duplicate apiId) |
| `InvalidStateError(message)` | `invalid_state` | Illegal state-machine transition |
| `UnauthorizedError(message?)` | `unauthorized` | Invalid/missing credentials |
| `ForbiddenError(scope)` | `forbidden` | Missing the required scope |

The HTTP layer maps each `code` to a status code — see [API reference](./api-reference.md#error-handling).

# SDKs

Five published client packages target the read-only **Delivery API** (plus an email connector).
They share a model (`DeliveredEntry`, `SearchHit`) but differ in surface and footprint.

## `@cw/sdk-core` — framework-agnostic Delivery client

Zero-dependency client for Node, SSR, edge runtimes, and tests.

```ts
import { createDeliveryClient } from '@cw/sdk-core';

const client = createDeliveryClient({
  baseUrl: 'https://cms.example.com',
  space: 'space-1',
  environment: 'main',
  token: '<cda-token>',
  fetch,                 // optional: inject a fetch (SSR/edge/test)
  cacheTtlMs: 0,         // optional in-memory cache (0 = off)
});
```

API:

```ts
client.getEntry<F>(id, { locale?, include? }): Promise<DeliveredEntry<F>>
client.listEntries<F>(query?): Promise<{ items: DeliveredEntry<F>[]; total: number }>
client.search(query, { topK? }): Promise<SearchHit[]>
client.query(): EntryQueryBuilder<F>     // fluent builder
client.clearCache(): void
```

- `EntryQuery` = `{ contentType?, locale?, include?, limit?, skip?, since?, filters?, order?, select?, search? }`.
- `filters` use the same operators as the HTTP query language (`eq`, `ne`, `in`, `match`, etc.).
- The fluent builder reads naturally:
  `client.query().contentType('article').locale('en-US').limit(10).fetch()`.
- `include` controls reference embedding depth (linked entries are nested in `fields`).
- `client.search()` hits `/search` with hybrid mode by default (same as the API).
- Failed requests throw `DeliveryError`.

Shapes:

```ts
interface DeliveredEntry<F = Fields> { id: string; contentType: string; fields: F; publishedAt: string; }
interface SearchHit { entryId: string; score: number; snippet: string; }
type DeliveryClient = ReturnType<typeof createDeliveryClient>;
```

## `@cw/sdk-web` — React hooks

Hooks layered over `@cw/sdk-core`. Provide a client once via context, then call hooks.

```tsx
import { createDeliveryClient } from '@cw/sdk-core';
import { ContentworkerProvider, useEntry, useEntries, useSemanticSearch } from '@cw/sdk-web';

const client = createDeliveryClient({ baseUrl, space, environment, token });

function App() {
  return (
    <ContentworkerProvider client={client}>
      <Article id="42" />
    </ContentworkerProvider>
  );
}

function Article({ id }: { id: string }) {
  const { data, error, loading } = useEntry(id, { locale: 'en-US', include: 1 });
  if (loading) return <Spinner />;
  if (error) return <Error error={error} />;
  return <h1>{String(data!.fields.title)}</h1>;
}
```

Hooks (all return `AsyncState<T> = { data?: T; error?: Error; loading: boolean }`):

- `useEntry<F>(id, { locale?, include? })`
- `useEntries<F>(query?)`
- `useSemanticSearch(query, { topK? })` — returns `[]` for an empty query (no request)
- `useDeliveryClient()` — the injected client

SSR-safe: no fetch happens on the server unless a hook is actually invoked.

## `@cw/sdk-edge` — tiny single-locale client

Minimal client for IoT, wearables, and kiosks. Always resolves to **one locale** and supports
field projection to keep payloads small.

```ts
import { createEdgeClient } from '@cw/sdk-edge';

const client = createEdgeClient({ baseUrl, space, environment, token, locale: 'en-US' });

await client.get('entry-42', ['title', 'body']);     // pick only these fields
await client.list('article', { limit: 20, pick: ['title'] });
```

Returns `CompactEntry` = `{ id, contentType, fields }` where `fields` is already flattened to the
client locale (no locale nesting).

| Use case | Package |
| --- | --- |
| Node/SSR/backend, or building your own integration | `@cw/sdk-core` |
| React apps | `@cw/sdk-web` |
| Constrained devices, single-locale, minimal payload | `@cw/sdk-edge` |
| React Native apps with offline sync | `@cw/sdk-react-native` |
| Email campaigns from republished content | `@cw/sdk-email` |

## `@cw/sdk-react-native` — offline Delivery sync

Hooks and helpers for React Native: offline entry cache, delta sync via `since`, and image URL
helpers. Builds on `@cw/sdk-core` with AsyncStorage-backed persistence.

```ts
import { createOfflineDelivery, useOfflineEntries } from '@cw/sdk-react-native';
```

## `@cw/sdk-email` — ESP connector

Maps delivered entries to email campaign payloads. Includes a Mailchimp adapter for list/campaign
integration — used by the `repurpose` agent workflow for content-to-newsletter flows.

```ts
import { createMailchimpConnector, mapEntryToCampaign } from '@cw/sdk-email';
```

## Choosing a client

All five published client packages are **read-only** Delivery clients except `@cw/sdk-email`,
which orchestrates outbound email from delivered content. For writes/publishing, call the
Management API directly or drive the MCP tools.

## GraphQL

If you prefer GraphQL over the REST client, the Delivery API also exposes a per-space GraphQL
schema generated from your content types at `POST /delivery/:space/:env/graphql` (scope
`delivery:read`). It needs no SDK — use any GraphQL client with a CDA token. See
[API reference → GraphQL Delivery](./api-reference.md#graphql-delivery).

import type { DeliveredEntry, DeliveryClient, EntryQuery, Fields, SearchHit } from '@cw/sdk-core';
/**
 * @cw/sdk-web — React hooks over @cw/sdk-core. Provide a client via
 * `ContentworkerProvider`, then call `useEntry` / `useEntries` /
 * `useSemanticSearch`. SSR-safe (no fetch on the server unless invoked).
 */
import {
  type ReactNode,
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
} from 'react';

export interface AsyncState<T> {
  readonly data?: T;
  readonly error?: Error;
  readonly loading: boolean;
}

const ClientContext = createContext<DeliveryClient | null>(null);

/** Supplies a Delivery client to the hook tree. */
export function ContentworkerProvider(props: { client: DeliveryClient; children: ReactNode }) {
  return createElement(ClientContext.Provider, { value: props.client }, props.children);
}

export function useDeliveryClient(): DeliveryClient {
  const client = useContext(ClientContext);
  if (!client) throw new Error('useDeliveryClient must be used within a <ContentworkerProvider>');
  return client;
}

function useAsync<T>(run: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ loading: true });
  // biome-ignore lint/correctness/useExhaustiveDependencies: `deps` is the caller-supplied dependency array, forwarded verbatim by design.
  useEffect(() => {
    let active = true;
    setState({ loading: true });
    run().then(
      (data) => active && setState({ data, loading: false }),
      (error) => active && setState({ error: error as Error, loading: false }),
    );
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

/** Fetches a single published entry. */
export function useEntry<F extends Fields = Fields>(
  id: string,
  opts: { locale?: string; include?: number } = {},
): AsyncState<DeliveredEntry<F>> {
  const client = useDeliveryClient();
  return useAsync(() => client.getEntry<F>(id, opts), [id, opts.locale, opts.include]);
}

/** Lists published entries. */
export function useEntries<F extends Fields = Fields>(
  query: EntryQuery = {},
): AsyncState<{ items: DeliveredEntry<F>[]; total: number }> {
  const client = useDeliveryClient();
  return useAsync(
    () => client.listEntries<F>(query),
    [query.contentType, query.locale, query.include, query.limit, query.skip],
  );
}

/** Semantic search over published content. */
export function useSemanticSearch(
  query: string,
  opts: { topK?: number } = {},
): AsyncState<SearchHit[]> {
  const client = useDeliveryClient();
  return useAsync(
    () => (query ? client.search(query, opts) : Promise.resolve([])),
    [query, opts.topK],
  );
}

export { createDeliveryClient } from '@cw/sdk-core';
export type { DeliveredEntry, EntryQuery, SearchHit, DeliveryClient } from '@cw/sdk-core';

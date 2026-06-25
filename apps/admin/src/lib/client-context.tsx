import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { useConnection } from './connection.js';
import { type Connection, type ManagementClient, createManagementClient } from './management.js';
import { useToast } from './toast.js';

/**
 * Shares the API connection + a memoized Management client across routes, plus a
 * `run()` helper that wraps async work with a busy flag and surfaces errors as
 * toasts. Replaces the prop-drilling the old single-component App relied on.
 */
interface ClientApi {
  readonly conn: Connection;
  readonly updateConn: (patch: Partial<Connection>) => void;
  readonly client: ManagementClient;
  readonly busy: boolean;
  run(fn: () => Promise<void>): Promise<void>;
}

const Ctx = createContext<ClientApi | null>(null);

export function useClient(): ClientApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useClient must be used within <ClientProvider>');
  return api;
}

export function ClientProvider(props: { children: React.ReactNode }) {
  const toast = useToast();
  const [conn, updateConn] = useConnection();
  const client = useMemo(() => createManagementClient(conn), [conn]);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const api = useMemo<ClientApi>(
    () => ({ conn, updateConn, client, busy, run }),
    [conn, updateConn, client, busy, run],
  );

  return <Ctx.Provider value={api}>{props.children}</Ctx.Provider>;
}

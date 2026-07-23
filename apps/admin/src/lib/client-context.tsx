import { useQueryClient } from '@tanstack/react-query';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { clearStoredConnection, useConnection } from './connection.js';
import { type Connection, type ManagementClient, createManagementClient } from './management.js';
import { useToast } from './toast.js';

/**
 * Shares the API connection + a memoized Management client across routes, plus a
 * `run()` helper that wraps async work with a busy flag and surfaces errors as
 * toasts. Replaces the prop-drilling the old single-component App relied on.
 *
 * `busy`/`run` are for the surface's PRIMARY mutation (saving a form, publishing)
 * — the flag is page-global, so a sidebar panel using it would disable the main
 * action while it fetches. Panels read via TanStack Query and run their own
 * mutations through `useLocalRun()` instead.
 */
interface ClientApi {
  readonly conn: Connection;
  readonly updateConn: (patch: Partial<Connection>) => void;
  readonly client: ManagementClient;
  readonly busy: boolean;
  readonly authReady: boolean;
  readonly authenticated: boolean;
  signOut(): void;
  run(fn: () => Promise<void>): Promise<void>;
}

const Ctx = createContext<ClientApi | null>(null);

export function useClient(): ClientApi {
  const api = useContext(Ctx);
  if (!api) throw new Error('useClient must be used within <ClientProvider>');
  return api;
}

/**
 * A busy flag + error-toasting runner scoped to the calling component. Same
 * contract as the context's `run`, but concurrent panels can't disable each
 * other's controls or race the shared flag.
 */
export function useLocalRun(): { busy: boolean; run: (fn: () => Promise<void>) => Promise<void> } {
  const toast = useToast();
  const [pending, setPending] = useState(0);
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setPending((n) => n + 1);
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setPending((n) => n - 1);
      }
    },
    [toast],
  );
  return { busy: pending > 0, run };
}

export function ClientProvider(props: { children: React.ReactNode }) {
  const toast = useToast();
  const [conn, updateConn] = useConnection();
  const [pending, setPending] = useState(0);
  const [authReady, setAuthReady] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const queryClient = useQueryClient();

  // Cached server state belongs to a principal, and query keys are scoped by
  // connection but deliberately not by token (a secret). So any token change —
  // sign-out, 401 sign-out, or swapping API keys on /connect — must drop the
  // whole cache, or the next principal would see data RBAC masks from them.
  const lastToken = useRef(conn.token);
  useEffect(() => {
    if (lastToken.current !== conn.token) {
      lastToken.current = conn.token;
      queryClient.clear();
    }
  }, [conn.token, queryClient]);

  const signOut = useCallback(() => {
    clearStoredConnection();
    updateConn({ token: '' });
    setAuthenticated(false);
  }, [updateConn]);

  const client = useMemo(
    () =>
      createManagementClient(conn, fetch, {
        onUnauthorized: () => {
          signOut();
          if (window.location.pathname !== '/connect') {
            window.location.assign('/connect');
          }
        },
      }),
    [conn, signOut],
  );

  useEffect(() => {
    // No token → unauthenticated, no request. Probing with an empty token
    // 401s, and that 401 used to trigger onUnauthorized → signOut →
    // updateConn (a fresh conn object even when nothing changed) → client
    // rebuild → re-probe: an infinite /auth/me loop in the built SPA, whose
    // stray in-flight 401s could also wipe a just-entered token via the
    // hard redirect. The probe uses a bare client (no onUnauthorized) so the
    // session check can only ever set state, never sign out or reload.
    if (!conn.token) {
      setAuthenticated(false);
      setAuthReady(true);
      return;
    }
    let cancelled = false;
    setAuthReady(false);
    createManagementClient(conn)
      .getPrincipal()
      .then(() => {
        if (!cancelled) setAuthenticated(true);
      })
      .catch(() => {
        if (!cancelled) setAuthenticated(false);
      })
      .finally(() => {
        if (!cancelled) setAuthReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [conn]);

  // Counter, not boolean: with overlapping runs a boolean would go idle when
  // the FIRST one finished, re-enabling controls while work is still in flight.
  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setPending((n) => n + 1);
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setPending((n) => n - 1);
      }
    },
    [toast],
  );
  const busy = pending > 0;

  const api = useMemo<ClientApi>(
    () => ({ conn, updateConn, client, busy, authReady, authenticated, signOut, run }),
    [conn, updateConn, client, busy, authReady, authenticated, signOut, run],
  );

  return <Ctx.Provider value={api}>{props.children}</Ctx.Provider>;
}

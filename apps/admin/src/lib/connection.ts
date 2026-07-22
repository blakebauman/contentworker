import { useCallback, useState } from 'react';
import type { Connection, PersistMode } from './management.js';

const LOCAL_KEY = 'cw-admin-connection';
const SESSION_KEY = 'cw-admin-connection-session';

const DEV_DEFAULT: Connection = {
  baseUrl: '',
  token: import.meta.env.DEV ? 'dev-cma-key' : '',
  space: 'space-1',
  environment: 'main',
  locale: 'en-US',
  persistMode: import.meta.env.DEV ? 'local' : 'session',
};

function storageKey(mode: PersistMode): string {
  return mode === 'session' ? SESSION_KEY : LOCAL_KEY;
}

function readStored(mode: PersistMode): Partial<Connection> | null {
  try {
    const raw =
      (mode === 'session' ? sessionStorage : localStorage).getItem(storageKey(mode)) ??
      (mode === 'session' ? null : localStorage.getItem(LOCAL_KEY));
    if (!raw) return null;
    return JSON.parse(raw) as Partial<Connection>;
  } catch {
    return null;
  }
}

function load(): Connection {
  const fromSession = readStored('session');
  const fromLocal = readStored('local');
  // Ignore any token that may be present in older stored payloads; the token is
  // in-memory only (DEV seeds a convenience default).
  const stored = fromLocal ?? fromSession ?? {};
  const saved = { ...DEV_DEFAULT, ...stored, token: DEV_DEFAULT.token };
  if (saved.environment === 'master') {
    return { ...saved, environment: 'main' };
  }
  return saved;
}

function persist(conn: Connection): void {
  const mode = conn.persistMode ?? 'local';
  // Never write the bearer token to web storage — any same-origin script (XSS,
  // a third-party app-extension iframe) could read it. The token lives only in
  // memory for the session; durable auth is the httpOnly SSO session cookie.
  const payload = JSON.stringify({ ...conn, token: '' });
  try {
    if (mode === 'session') {
      sessionStorage.setItem(storageKey('session'), payload);
      localStorage.removeItem(LOCAL_KEY);
    } else {
      localStorage.setItem(LOCAL_KEY, payload);
      sessionStorage.removeItem(SESSION_KEY);
    }
  } catch {
    /* ignore quota errors */
  }
}

/** Clears stored credentials from both storage backends. */
export function clearStoredConnection(): void {
  try {
    localStorage.removeItem(LOCAL_KEY);
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

/** Connection settings persisted to localStorage or sessionStorage. */
export function useConnection(): [Connection, (patch: Partial<Connection>) => void] {
  const [conn, setConn] = useState<Connection>(load);
  const update = useCallback((patch: Partial<Connection>) => {
    setConn((prev) => {
      const next = { ...prev, ...patch };
      persist(next);
      return next;
    });
  }, []);
  return [conn, update];
}

import { useCallback, useState } from 'react';
import type { Connection } from './management.js';

const KEY = 'cw-admin-connection';

const DEFAULT: Connection = {
  baseUrl: 'http://localhost:8787',
  token: 'dev-cma-key',
  space: 'space-1',
  environment: 'master',
  locale: 'en-US',
};

function load(): Connection {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT, ...(JSON.parse(raw) as Partial<Connection>) } : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

/** Connection settings persisted to localStorage. */
export function useConnection(): [Connection, (patch: Partial<Connection>) => void] {
  const [conn, setConn] = useState<Connection>(load);
  const update = useCallback((patch: Partial<Connection>) => {
    setConn((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);
  return [conn, update];
}

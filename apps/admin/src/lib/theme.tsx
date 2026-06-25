import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

type Theme = 'light' | 'dark';

interface ThemeApi {
  readonly theme: Theme;
  toggle(): void;
}

const KEY = 'cw-admin-theme';
const ThemeCtx = createContext<ThemeApi | null>(null);

function load(): Theme {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* ignore */
  }
  // Default to dark — the admin shipped `class="dark"` on <html>.
  return 'dark';
}

/** Reads/sets the `dark` class on <html>, persisted to localStorage. */
export function useTheme(): ThemeApi {
  const api = useContext(ThemeCtx);
  if (!api) throw new Error('useTheme must be used within <ThemeProvider>');
  return api;
}

export function ThemeProvider(props: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(load);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle('dark', theme === 'dark');
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : 'dark')), []);
  const api = useMemo<ThemeApi>(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeCtx.Provider value={api}>{props.children}</ThemeCtx.Provider>;
}

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import type { ContentType } from '@cw/domain';
import { FileText, Image, LayoutDashboard, Search, Settings as SettingsIcon } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClient } from '../../lib/client-context.js';
import type { PreviewEntry } from '../../lib/management.js';

interface Item {
  readonly group: string;
  readonly label: string;
  readonly to: string;
  readonly icon?: typeof FileText;
  readonly search: string;
}

const SECTIONS: Item[] = [
  {
    group: 'Go to',
    label: 'Dashboard',
    to: '/dashboard',
    icon: LayoutDashboard,
    search: 'dashboard',
  },
  { group: 'Go to', label: 'Content', to: '/content', icon: FileText, search: 'content' },
  { group: 'Go to', label: 'Media', to: '/media', icon: Image, search: 'media' },
  { group: 'Go to', label: 'Settings', to: '/settings', icon: SettingsIcon, search: 'settings' },
];

const OPEN_EVENT = 'cw:command-open';

/** Open the global command palette from anywhere (e.g. a topbar button). */
export const openCommandPalette = () => window.dispatchEvent(new Event(OPEN_EVENT));

/**
 * Global quick-jump palette (Cmd/Ctrl-K). A Dialog with a filtered, grouped list
 * and arrow-key navigation. Loads content types + entries lazily on first open
 * and routes to the matching section/type/entry.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const { client, conn } = useClient();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [types, setTypes] = useState<ContentType[]>([]);
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Cmd-K / Ctrl-K toggles the palette; a custom event opens it (topbar button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = () => setOpen(true);
    document.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Reset the query/selection and focus the input each time it opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
      // Focus after the dialog mounts its content.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Lazy-load the searchable index the first time the palette opens.
  useEffect(() => {
    if (!open || loaded) return;
    let live = true;
    (async () => {
      try {
        const [ts, es] = await Promise.all([
          client.listContentTypes(),
          client.listEntries().catch(() => []),
        ]);
        if (!live) return;
        setTypes(ts);
        setEntries(es);
        setLoaded(true);
      } catch {
        /* palette still offers section nav even if the index fails to load */
      }
    })();
    return () => {
      live = false;
    };
  }, [open, loaded, client]);

  const items = useMemo<Item[]>(() => {
    const displayFieldOf = new Map(types.map((t) => [t.apiId, t.displayField]));
    const typeItems: Item[] = types.map((t) => ({
      group: 'Content types',
      label: t.name,
      to: `/content/${t.apiId}`,
      icon: FileText,
      search: `${t.name} ${t.apiId}`.toLowerCase(),
    }));
    const entryItems: Item[] = entries.slice(0, 100).map((e) => {
      const df = displayFieldOf.get(e.contentType);
      const title = df
        ? (e.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
        : undefined;
      const label = String(title ?? e.id);
      return {
        group: 'Entries',
        label,
        to: `/content/${e.contentType}/${e.id}`,
        search: `${label} ${e.id}`.toLowerCase(),
      };
    });
    return [...SECTIONS, ...typeItems, ...entryItems];
  }, [types, entries, conn.locale]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? items.filter((i) => i.search.includes(q)) : items;
    return list.slice(0, 50);
  }, [items, query]);

  const go = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    navigate(item.to);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      go(filtered[active]);
    }
  };

  // Render grouped, tracking a flat index for keyboard highlight.
  let flat = -1;
  const groups = ['Go to', 'Content types', 'Entries'];

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent showCloseButton={false} className="overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Jump to a section, content type, or entry…"
            className="h-11 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command palette search"
          />
        </div>
        <div className="max-h-80 overflow-y-auto p-1">
          {filtered.length === 0 && (
            <div className="py-6 text-center text-sm text-muted-foreground">No results found.</div>
          )}
          {groups.map((g) => {
            const inGroup = filtered.filter((i) => i.group === g);
            if (inGroup.length === 0) return null;
            return (
              <div key={g} className="mb-1">
                <div className="px-2 py-1.5 text-xs font-medium text-muted-foreground">{g}</div>
                {inGroup.map((item) => {
                  flat += 1;
                  const idx = flat;
                  return (
                    <button
                      key={item.to}
                      type="button"
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => go(item)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm',
                        idx === active ? 'bg-accent text-accent-foreground' : 'text-foreground',
                      )}
                    >
                      {item.icon && <item.icon className="size-4 text-muted-foreground" />}
                      <span className="truncate">{item.label}</span>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </DialogContent>
    </Dialog>
  );
}

import { cn } from '@/lib/utils';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';
import { useContentTypesQuery, useQueryKeys, useSpaceConfigQuery } from '../lib/queries.js';
import type { ContentOutlet } from './content-context.js';

/**
 * Content section shell: a secondary nav listing the space's content types,
 * beside an outlet that renders the entries list / entry editor. Content types
 * and locale config come from the query cache and are shared with nested
 * routes; `reload` invalidates both so any nested mutation can refresh them.
 */
export function ContentLayout() {
  const { conn } = useClient();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();
  const typesQuery = useContentTypesQuery();
  const configQuery = useSpaceConfigQuery();

  const types = typesQuery.data ?? [];
  const cfg = configQuery.data ?? null;

  const reload = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: keys.contentTypes });
    void queryClient.invalidateQueries({ queryKey: keys.spaceConfig });
  }, [queryClient, keys]);

  const outlet: ContentOutlet = {
    types,
    locales: cfg?.locales ?? [conn.locale],
    defaultLocale: cfg?.defaultLocale ?? conn.locale,
    fallbacks: cfg?.fallbacks,
    reload,
  };

  return (
    <div className="grid grid-cols-1 gap-6 md:grid-cols-[200px_1fr]">
      <aside className="space-y-1">
        <div className="px-2 py-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Content types
        </div>
        {types.map((t) => (
          <NavLink
            key={t.apiId}
            to={`/content/${t.apiId}`}
            className={({ isActive }) =>
              cn(
                'flex items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                isActive
                  ? 'bg-accent text-accent-foreground font-medium'
                  : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )
            }
          >
            <span>{t.name}</span>
            <span className="text-xs text-muted-foreground">{t.status}</span>
          </NavLink>
        ))}
        {types.length === 0 && !typesQuery.isPending && (
          <div className="px-2 py-1 text-sm text-muted-foreground">No content types.</div>
        )}
      </aside>

      <section className="min-w-0">
        <Outlet context={outlet} />
      </section>
    </div>
  );
}

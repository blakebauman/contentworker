import { cn } from '@/lib/utils';
import type { ContentType } from '@cw/domain';
import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';
import type { SpaceConfig } from '../lib/management.js';
import type { ContentOutlet } from './content-context.js';

type LocaleConfig = { locales: readonly string[]; defaultLocale: string };

/**
 * Content section shell: a secondary nav listing the space's content types,
 * beside an outlet that renders the entries list / entry editor. Loads the
 * content types + locale config once and shares them with nested routes.
 */
export function ContentLayout() {
  const { client, conn, run } = useClient();
  const [types, setTypes] = useState<ContentType[]>([]);
  const [localeCfg, setLocaleCfg] = useState<LocaleConfig>({
    locales: [conn.locale],
    defaultLocale: conn.locale,
  });

  const reload = useCallback(
    () =>
      run(async () => {
        const [ts, cfg] = await Promise.all([
          client.listContentTypes(),
          client.getSpaceConfig().catch((): SpaceConfig | null => null),
        ]);
        setTypes(ts);
        if (cfg) setLocaleCfg({ locales: cfg.locales, defaultLocale: cfg.defaultLocale });
      }),
    [client, run],
  );

  useEffect(() => {
    reload();
  }, [reload]);

  const outlet: ContentOutlet = {
    types,
    locales: localeCfg.locales,
    defaultLocale: localeCfg.defaultLocale,
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
        {types.length === 0 && (
          <div className="px-2 py-1 text-sm text-muted-foreground">No content types.</div>
        )}
      </aside>

      <section className="min-w-0">
        <Outlet context={outlet} />
      </section>
    </div>
  );
}

/** Default content pane shown at /content before a type is selected. */
export function ContentIndex() {
  return <p className="text-muted-foreground">Select a content type to browse its entries.</p>;
}

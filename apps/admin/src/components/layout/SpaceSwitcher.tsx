import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEffect, useState } from 'react';
import { useClient } from '../../lib/client-context.js';
import { EnvironmentSwitcher } from './EnvironmentSwitcher.js';
import { SpaceMenu } from './SpaceMenu.js';

/**
 * Topbar controls for the active space / environment / locale: a space switcher,
 * an environment (branch) switcher, and a locale Select from the space's config.
 */
export function SpaceSwitcher() {
  const { conn, updateConn, client } = useClient();
  const [locales, setLocales] = useState<readonly string[]>([conn.locale]);

  useEffect(() => {
    let live = true;
    client
      .getSpaceConfig()
      .then((cfg) => live && setLocales(cfg.locales.length ? cfg.locales : [conn.locale]))
      .catch(() => live && setLocales([conn.locale]));
    return () => {
      live = false;
    };
  }, [client, conn.locale]);

  // Ensure the current locale is always selectable even if it isn't in the config.
  const options = locales.includes(conn.locale) ? locales : [conn.locale, ...locales];

  return (
    <div className="flex items-center gap-2">
      <SpaceMenu />
      <EnvironmentSwitcher />
      <Select value={conn.locale} onValueChange={(locale) => updateConn({ locale })}>
        <SelectTrigger size="sm" className="w-28" aria-label="Locale">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((loc) => (
            <SelectItem key={loc} value={loc}>
              {loc}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

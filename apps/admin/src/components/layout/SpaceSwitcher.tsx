import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClient } from '../../lib/client-context.js';
import { EnvironmentSwitcher } from './EnvironmentSwitcher.js';

/**
 * Topbar controls for the active space / environment / locale. The space is a
 * chip linking to /settings/connection; the environment is a branch switcher;
 * the locale is a Select populated from the space's configured locales.
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
      <Button asChild variant="outline" size="sm" title="Space settings">
        <Link to="/settings/connection">
          <span className="font-medium">{conn.space || 'no space'}</span>
        </Link>
      </Button>
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

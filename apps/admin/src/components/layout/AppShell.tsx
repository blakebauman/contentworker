import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  FileText,
  Image,
  LayoutDashboard,
  Moon,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { NavLink, Outlet } from 'react-router-dom';
import { useTheme } from '../../lib/theme.js';
import { Breadcrumbs } from './Breadcrumbs.js';
import { SpaceSwitcher } from './SpaceSwitcher.js';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/content', label: 'Content', icon: FileText },
  { to: '/media', label: 'Media', icon: Image },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

/** Persistent app chrome: left nav rail + topbar (breadcrumbs, space switcher, theme). */
export function AppShell() {
  return (
    <div className="grid h-screen grid-cols-[220px_1fr] grid-rows-[auto_1fr]">
      <aside className="row-span-2 flex flex-col gap-1 border-r bg-sidebar p-3">
        <div className="px-2 py-3 text-sm font-semibold tracking-tight">contentworker</div>
        <nav className="flex flex-col gap-0.5">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground',
                )
              }
            >
              <item.icon className="size-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <header className="flex items-center justify-between gap-4 border-b bg-background px-5 py-2.5">
        <Breadcrumbs />
        <div className="flex items-center gap-2">
          <SpaceSwitcher />
          <ThemeToggle />
        </div>
      </header>

      <main className="overflow-auto p-6">
        <Outlet />
      </main>
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      onClick={toggle}
      aria-label="Toggle theme"
      title="Toggle theme"
    >
      {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
    </Button>
  );
}

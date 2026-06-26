import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  FileText,
  GitBranch,
  Image,
  LayoutDashboard,
  Menu,
  Moon,
  Rocket,
  Search,
  Settings as SettingsIcon,
  Sun,
} from 'lucide-react';
import { useState } from 'react';
import { Link, NavLink, Outlet } from 'react-router-dom';
import { useClient } from '../../lib/client-context.js';
import { useTheme } from '../../lib/theme.js';
import { Breadcrumbs } from './Breadcrumbs.js';
import { CommandPalette, openCommandPalette } from './CommandPalette.js';
import { SpaceSwitcher } from './SpaceSwitcher.js';

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/content', label: 'Content', icon: FileText },
  { to: '/releases', label: 'Releases', icon: Rocket },
  { to: '/workflows', label: 'Workflows', icon: GitBranch },
  { to: '/media', label: 'Media', icon: Image },
  { to: '/settings', label: 'Settings', icon: SettingsIcon },
];

/** Persistent app chrome: a nav rail (drawer on mobile) + topbar. */
export function AppShell() {
  const [mobileNav, setMobileNav] = useState(false);

  return (
    <div className="flex h-screen">
      {/* Rail on md+, hidden on small screens (replaced by the drawer). */}
      <aside className="hidden w-[220px] shrink-0 border-r bg-sidebar md:block">
        <SidebarNav />
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b bg-background px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-2">
            <Sheet open={mobileNav} onOpenChange={setMobileNav}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="md:hidden" aria-label="Open menu">
                  <Menu className="size-4" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-[220px] bg-sidebar p-0">
                <SheetTitle className="sr-only">Navigation</SheetTitle>
                <SidebarNav onNavigate={() => setMobileNav(false)} />
              </SheetContent>
            </Sheet>
            <Breadcrumbs />
          </div>
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={openCommandPalette}
                  className="gap-2 text-muted-foreground"
                >
                  <Search className="size-4" />
                  <span className="hidden sm:inline">Search</span>
                  <kbd className="hidden rounded border bg-muted px-1 text-[10px] sm:inline">
                    ⌘K
                  </kbd>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Jump to anything (⌘K)</TooltipContent>
            </Tooltip>
            <div className="hidden sm:block">
              <SpaceSwitcher />
            </div>
            <ThemeToggle />
            <AccountMenu />
          </div>
        </header>

        <main className="overflow-auto p-6">
          <Outlet />
        </main>
      </div>

      <CommandPalette />
    </div>
  );
}

/** Brand + primary nav links, reused by the rail and the mobile drawer. */
function SidebarNav(props: { onNavigate?: () => void }) {
  return (
    <div className="flex flex-col gap-1 p-3">
      <div className="px-2 py-3 text-sm font-semibold tracking-tight">contentworker</div>
      <nav className="flex flex-col gap-0.5">
        {NAV.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            onClick={props.onNavigate}
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
    </div>
  );
}

function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={toggle}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{theme === 'dark' ? 'Light mode' : 'Dark mode'}</TooltipContent>
    </Tooltip>
  );
}

/** Avatar dropdown showing the active connection identity + shortcuts to settings. */
function AccountMenu() {
  const { conn } = useClient();
  const initials =
    (conn.space || 'cw')
      .replace(/[^a-z0-9]/gi, '')
      .slice(0, 2)
      .toUpperCase() || 'CW';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="rounded-full" aria-label="Account">
          <Avatar className="size-7">
            <AvatarFallback className="text-xs">{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel>
          <div className="font-medium">{conn.space || 'no space'}</div>
          <div className="text-xs font-normal text-muted-foreground">
            environment: {conn.environment || 'main'}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings/connection">Connection settings</Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings/api-keys">API keys</Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

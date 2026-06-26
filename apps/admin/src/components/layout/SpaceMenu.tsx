import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { Check, Layers, Plus, Settings } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClient } from '../../lib/client-context.js';
import type { SpaceRef } from '../../lib/management.js';

/**
 * Space switcher: lists the spaces the token can reach (admin → all, a scoped
 * key → its own), switches on select, and provisions new ones (admin only).
 * Switching resets the environment to "main" since branches are per-space.
 */
export function SpaceMenu() {
  const { conn, updateConn, client } = useClient();
  const [spaces, setSpaces] = useState<SpaceRef[]>([{ id: conn.space, name: conn.space }]);
  const [createOpen, setCreateOpen] = useState(false);

  useEffect(() => {
    let live = true;
    client
      .listSpaces()
      .then((s) => live && setSpaces(s.length ? s : [{ id: conn.space, name: conn.space }]))
      .catch(() => live && setSpaces([{ id: conn.space, name: conn.space }]));
    return () => {
      live = false;
    };
  }, [client, conn.space]);

  const switchSpace = (id: string) => {
    if (id !== conn.space) updateConn({ space: id, environment: 'main' });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" className="gap-1.5" title="Switch space">
            <Layers className="size-4 text-muted-foreground" />
            <span className="font-medium">{conn.space || 'no space'}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Spaces</DropdownMenuLabel>
          {spaces.map((s) => (
            <DropdownMenuItem
              key={s.id}
              onClick={() => switchSpace(s.id)}
              className="justify-between"
            >
              <span className="flex flex-col">
                <span>{s.name}</span>
                {s.name !== s.id && <span className="text-xs text-muted-foreground">{s.id}</span>}
              </span>
              <Check className={cn('size-4', s.id === conn.space ? 'opacity-100' : 'opacity-0')} />
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setCreateOpen(true)}>
            <Plus className="size-4" /> New space…
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings/connection">
              <Settings className="size-4" /> Connection settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <CreateSpaceDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={(id) => updateConn({ space: id, environment: 'main' })}
      />
    </>
  );
}

function CreateSpaceDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const { client } = useClient();
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [defaultLocale, setDefaultLocale] = useState('en-US');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const spaceId = id.trim();
    if (!spaceId || !name.trim() || !defaultLocale.trim()) {
      setError('Space ID, name, and default locale are required.');
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await client.createSpace({ spaceId, name: name.trim(), defaultLocale: defaultLocale.trim() });
      props.onCreated(spaceId);
      props.onOpenChange(false);
      setId('');
      setName('');
    } catch (err) {
      // Creating a space needs the admin token; surface that hint on 403.
      const msg = err instanceof Error ? err.message : String(err);
      setError(
        /403/.test(msg)
          ? 'Provisioning a space requires the admin token (Connection settings).'
          : msg,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>New space</DialogTitle>
          <DialogDescription>
            Provision a new space with a default environment. Requires the admin token.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="space-id">Space ID</Label>
              <Input
                id="space-id"
                value={id}
                placeholder="blog"
                className="font-mono"
                onChange={(e) => setId(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="space-name">Name</Label>
              <Input
                id="space-name"
                value={name}
                placeholder="Blog"
                onChange={(e) => setName(e.target.value)}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="space-locale">Default locale</Label>
            <Input
              id="space-locale"
              value={defaultLocale}
              className="w-32 font-mono"
              onChange={(e) => setDefaultLocale(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Creating…' : 'Create & switch'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

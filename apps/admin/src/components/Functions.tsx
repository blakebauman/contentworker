import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Zap } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FunctionDefinition, ManagementClient } from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/** Manage user-defined functions: HTTP endpoints invoked on matching events. */
export function Functions(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [fns, setFns] = useState<FunctionDefinition[]>([]);
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('entry.*');
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setFns(await client.listFunctions());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await client.createFunction({
        name: name.trim(),
        eventPattern: pattern.trim(),
        url: url.trim(),
      });
      setName('');
      setUrl('');
      await load();
      toast.success('Function registered');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await client.deleteFunction(id);
      await load();
      toast.success('Deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">New function</h2>
          <p className="text-muted-foreground text-sm">
            An HTTP endpoint invoked with the event payload whenever an event matches the pattern (
            <code className="text-xs">*</code>, <code className="text-xs">entry.*</code>, or an
            exact type like <code className="text-xs">entry.published</code>).
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={create} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="fn-name">Name</Label>
              <Input
                id="fn-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="reindex-search"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="fn-pattern">Event pattern</Label>
              <Input
                id="fn-pattern"
                value={pattern}
                onChange={(e) => setPattern(e.target.value)}
                className="w-40"
              />
            </div>
            <div className="flex-1 space-y-1.5">
              <Label htmlFor="fn-url">URL</Label>
              <Input
                id="fn-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/on-event"
              />
            </div>
            <Button type="submit" disabled={!name.trim() || !url.trim() || busy}>
              {busy ? 'Saving…' : 'Register'}
            </Button>
          </form>
        </CardContent>
      </Card>

      {fns.length === 0 ? (
        <p className="text-muted-foreground text-sm">No functions registered.</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Event</TableHead>
              <TableHead>URL</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {fns.map((f) => (
              <TableRow key={f.id}>
                <TableCell className="font-medium">
                  <span className="flex items-center gap-1.5">
                    <Zap className="size-3.5 text-primary" />
                    {f.name}
                  </span>
                </TableCell>
                <TableCell>
                  <Badge variant="outline">{f.eventPattern}</Badge>
                </TableCell>
                <TableCell className="max-w-64 truncate font-mono text-muted-foreground text-xs">
                  {f.url}
                </TableCell>
                <TableCell>
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(f.id)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { FileText } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EntryDiff } from '../components/EntryDiff.js';
import { useClient } from '../lib/client-context.js';
import type { PreviewEntry } from '../lib/management.js';
import { useToast } from '../lib/toast.js';
import { useContentOutlet } from './content-context.js';

/** Entries table for one content type, with bulk publishing and a draft/published diff. */
export function EntriesList() {
  const { typeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types } = useContentOutlet();

  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diffEntry, setDiffEntry] = useState<PreviewEntry | null>(null);

  const selectedType = types.find((t) => t.apiId === typeId);

  const loadEntries = useCallback(
    () =>
      run(async () => {
        if (!typeId) return;
        setLoading(true);
        try {
          setEntries(await client.listEntries(typeId));
        } finally {
          setLoading(false);
        }
      }),
    [client, run, typeId],
  );

  // Reload when the selected content type changes; clear cross-type UI state.
  useEffect(() => {
    setPicked(new Set());
    setDiffEntry(null);
    loadEntries();
  }, [loadEntries]);

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Optimistically reflect a status change; reconcile on success, roll back on failure.
  const optimisticStatus = (ids: Set<string>, status: string) =>
    setEntries((es) => es.map((e) => (ids.has(e.id) ? { ...e, status } : e)));

  const bulk = (action: (id: string) => Promise<unknown>, verb: string, status: string) => {
    const snapshot = entries;
    const ids = picked;
    optimisticStatus(ids, status);
    setPicked(new Set());
    return run(async () => {
      try {
        for (const id of ids) await action(id);
      } catch (e) {
        setEntries(snapshot);
        throw e;
      }
      await loadEntries();
      toast.success(`${verb} ${ids.size} ${ids.size === 1 ? 'entry' : 'entries'}`);
    });
  };

  const setStatus = (
    id: string,
    status: string,
    act: (id: string) => Promise<unknown>,
    msg: string,
  ) => {
    const snapshot = entries;
    optimisticStatus(new Set([id]), status);
    return run(async () => {
      try {
        await act(id);
      } catch (e) {
        setEntries(snapshot);
        throw e;
      }
      await loadEntries();
      toast.success(msg);
    });
  };

  if (!selectedType) {
    return <p className="text-muted-foreground">Select a content type to browse its entries.</p>;
  }

  const count = entries.length;
  return (
    <div className="space-y-4">
      <PageHeader
        title={`${selectedType.name} entries`}
        description={loading ? undefined : `${count} ${count === 1 ? 'entry' : 'entries'}`}
      >
        {picked.size > 0 && (
          <>
            <span className="text-sm text-muted-foreground">{picked.size} selected</span>
            <Button
              type="button"
              onClick={() => bulk((id) => client.publishEntry(id), 'Published', 'published')}
              disabled={busy}
            >
              Publish selected
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => bulk((id) => client.unpublishEntry(id), 'Unpublished', 'draft')}
              disabled={busy}
            >
              Unpublish selected
            </Button>
          </>
        )}
        <Button
          type="button"
          onClick={() => navigate(`/content/${selectedType.apiId}/new`)}
          disabled={busy}
        >
          + New entry
        </Button>
      </PageHeader>

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No entries yet"
          description={`Create the first ${selectedType.name} entry to get started.`}
        >
          <Button
            type="button"
            onClick={() => navigate(`/content/${selectedType.apiId}/new`)}
            disabled={busy}
          >
            Create entry
          </Button>
        </EmptyState>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8" />
              <TableHead>{selectedType.displayField}</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-[320px]">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Checkbox
                    aria-label={`Select ${e.id}`}
                    checked={picked.has(e.id)}
                    onCheckedChange={() => togglePick(e.id)}
                  />
                </TableCell>
                <TableCell>
                  {String(
                    (e.fields[selectedType.displayField] as Record<string, unknown>)?.[
                      conn.locale
                    ] ?? '—',
                  )}
                </TableCell>
                <TableCell>
                  <StatusBadge status={e.status} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => navigate(`/content/${selectedType.apiId}/${e.id}`)}
                      disabled={busy}
                    >
                      Edit
                    </Button>
                    {e.status !== 'draft' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setDiffEntry(diffEntry?.id === e.id ? null : e)}
                        disabled={busy}
                      >
                        Diff
                      </Button>
                    )}
                    <Button
                      type="button"
                      size="sm"
                      onClick={() =>
                        setStatus(
                          e.id,
                          'published',
                          (id) => client.publishEntry(id),
                          'Entry published',
                        )
                      }
                      disabled={busy}
                    >
                      Publish
                    </Button>
                    {e.status === 'published' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setStatus(
                            e.id,
                            'draft',
                            (id) => client.unpublishEntry(id),
                            'Entry unpublished',
                          )
                        }
                        disabled={busy}
                      >
                        Unpublish
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <Sheet open={!!diffEntry} onOpenChange={(o) => !o && setDiffEntry(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          <SheetHeader>
            <SheetTitle>Diff vs published</SheetTitle>
            <SheetDescription>Draft changes since this entry was last published.</SheetDescription>
          </SheetHeader>
          <div className="px-4 pb-4">
            {diffEntry && <EntryDiff client={client} entry={diffEntry} locale={conn.locale} />}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

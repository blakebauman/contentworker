import { EmptyState } from '@/components/EmptyState';
import { EntryFilterBar } from '@/components/EntryFilterBar';
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
import type { EntryListQuery, PreviewEntry } from '../lib/management.js';
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
  const [query, setQuery] = useState<EntryListQuery>({});

  const selectedType = types.find((t) => t.apiId === typeId);

  const loadEntries = useCallback(
    (q: EntryListQuery) =>
      run(async () => {
        if (!typeId) return;
        setLoading(true);
        try {
          setEntries(await client.listEntries(typeId, q));
        } finally {
          setLoading(false);
        }
      }),
    [client, run, typeId],
  );

  // Reset filters and cross-type UI state when the selected content type changes.
  useEffect(() => {
    if (typeId) {
      setPicked(new Set());
      setDiffEntry(null);
      setQuery({});
    }
  }, [typeId]);

  // Re-query (debounced) whenever the type or the filter/sort/search query changes.
  useEffect(() => {
    const handle = setTimeout(() => loadEntries(query), 250);
    return () => clearTimeout(handle);
  }, [loadEntries, query]);

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

  // One bulk API call handles the whole selection server-side, reporting
  // per-item outcomes; we surface any partial failures in the toast.
  const bulk = (action: 'publish' | 'unpublish', verb: string, status: string) => {
    const snapshot = entries;
    const ids = [...picked];
    optimisticStatus(picked, status);
    setPicked(new Set());
    return run(async () => {
      let summary: { succeeded: number; failed: number };
      try {
        summary = await client.bulkEntryAction(action, ids);
      } catch (e) {
        setEntries(snapshot);
        throw e;
      }
      await loadEntries(query);
      toast.success(
        summary.failed > 0
          ? `${verb} ${summary.succeeded}, ${summary.failed} failed`
          : `${verb} ${summary.succeeded} ${summary.succeeded === 1 ? 'entry' : 'entries'}`,
      );
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
      await loadEntries(query);
      toast.success(msg);
    });
  };

  if (!selectedType) {
    return <p className="text-muted-foreground">Select a content type to browse its entries.</p>;
  }

  const count = entries.length;
  const hasQuery = (query.filters?.length ?? 0) > 0 || !!query.search;
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
              onClick={() => bulk('publish', 'Published', 'published')}
              disabled={busy}
            >
              Publish selected
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => bulk('unpublish', 'Unpublished', 'draft')}
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

      <EntryFilterBar type={selectedType} value={query} onChange={setQuery} />

      {loading ? (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : entries.length === 0 && hasQuery ? (
        <EmptyState
          icon={FileText}
          title="No matching entries"
          description="No entries match the current filters. Try loosening or clearing them."
        >
          <Button type="button" variant="outline" onClick={() => setQuery({})} disabled={busy}>
            Clear filters
          </Button>
        </EmptyState>
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

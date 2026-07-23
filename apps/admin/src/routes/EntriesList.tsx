import { EmptyState } from '@/components/EmptyState';
import { EntryFilterBar } from '@/components/EntryFilterBar';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
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
import { useQueryClient } from '@tanstack/react-query';
import { FileText } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { EntryDiff } from '../components/EntryDiff.js';
import { useClient } from '../lib/client-context.js';
import type { EntryListQuery, PreviewEntry } from '../lib/management.js';
import { useDebouncedValue, useEntriesQuery, useQueryKeys } from '../lib/queries.js';
import { useToast } from '../lib/toast.js';
import { useContentOutlet } from './content-context.js';

/** Entries table for one content type, with bulk publishing and a draft/published diff. */
export function EntriesList() {
  const { typeId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types } = useContentOutlet();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();

  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diffEntry, setDiffEntry] = useState<PreviewEntry | null>(null);
  // Bulk action awaiting confirmation (bulk selections are tedious to rebuild,
  // so the whole batch is confirmed once before it runs).
  const [confirmBulk, setConfirmBulk] = useState<'publish' | 'unpublish' | null>(null);
  // Per-item failures from the last bulk action, with resolved titles so the
  // editor knows WHICH entries failed, not just how many.
  const [bulkFailures, setBulkFailures] = useState<
    { id: string; title: string; error?: string }[] | null
  >(null);
  // Filter state is bound to the type it was authored for and reset in-render
  // when the type changes, so a stale filter (naming another type's fields)
  // can never be combined with the new type's query key — not even for the
  // 250ms the debounce would otherwise lag.
  const [filterState, setFilterState] = useState<{
    typeId: string | undefined;
    query: EntryListQuery;
  }>({ typeId, query: {} });
  if (filterState.typeId !== typeId) {
    setFilterState({ typeId, query: {} });
    setPicked(new Set());
    setDiffEntry(null);
    setConfirmBulk(null);
    setBulkFailures(null);
  }
  const query = filterState.typeId === typeId ? filterState.query : {};
  const setQuery = (q: EntryListQuery) => setFilterState({ typeId, query: q });

  const selectedType = types.find((t) => t.apiId === typeId);

  // The list is keyed by type + debounced filters; edits to the filter bar
  // re-key the query after 250ms while the previous page stays visible.
  const debounced = useDebouncedValue(filterState, 250);
  const debouncedQuery = debounced.typeId === typeId ? debounced.query : {};
  const entriesQuery = useEntriesQuery(typeId, debouncedQuery);
  const entries = entriesQuery.data ?? [];
  const loading = entriesQuery.isPending;
  const entriesKey = keys.entries(typeId, debouncedQuery);

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // Optimistically reflect a status change in the cached list; roll back on failure.
  const optimisticStatus = (ids: Set<string>, status: string) =>
    queryClient.setQueryData<PreviewEntry[]>(entriesKey, (es) =>
      es?.map((e) => (ids.has(e.id) ? { ...e, status } : e)),
    );

  const refreshEntries = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: keys.entriesRoot }),
      // Publish/unpublish change an entry's status/version, which the editor's
      // detail query also holds.
      queryClient.invalidateQueries({ queryKey: keys.entryRoot }),
    ]);

  // Shared mutation shell: cancel in-flight list refetches so they can't stomp
  // the optimistic write, skip the optimistic write entirely while the table
  // shows placeholder rows from another key, and always revalidate — success
  // or failure — so the cache never keeps a rolled-back or half-applied list.
  const mutateEntries = (act: () => Promise<void>) =>
    run(async () => {
      await queryClient.cancelQueries({ queryKey: keys.entriesRoot });
      try {
        await act();
      } finally {
        await refreshEntries();
      }
    });

  const titleOf = (id: string) => {
    const entry = entries.find((e) => e.id === id);
    const value = selectedType
      ? (entry?.fields[selectedType.displayField] as Record<string, unknown> | undefined)?.[
          conn.locale
        ]
      : undefined;
    return typeof value === 'string' && value ? value : id;
  };

  // One bulk API call handles the whole selection server-side, reporting
  // per-item outcomes; partial failures are surfaced by entry, not as a count.
  const bulk = (action: 'publish' | 'unpublish', verb: string, status: string) => {
    const ids = [...picked];
    setPicked(new Set());
    setBulkFailures(null);
    return mutateEntries(async () => {
      const optimistic = !entriesQuery.isPlaceholderData;
      const snapshot = entries;
      if (optimistic) optimisticStatus(new Set(ids), status);
      let summary: Awaited<ReturnType<typeof client.bulkEntryAction>>;
      try {
        summary = await client.bulkEntryAction(action, ids);
      } catch (e) {
        if (optimistic) queryClient.setQueryData(entriesKey, snapshot);
        throw e;
      }
      if (summary.failed > 0) {
        setBulkFailures(
          summary.results
            .filter((r) => !r.ok)
            .map((r) => ({ id: r.id, title: titleOf(r.id), error: r.error })),
        );
        toast.error(`${verb} ${summary.succeeded}; ${summary.failed} failed (details in the list)`);
      } else {
        toast.success(
          `${verb} ${summary.succeeded} ${summary.succeeded === 1 ? 'entry' : 'entries'}`,
        );
      }
    });
  };

  const setStatus = (
    id: string,
    status: string,
    act: (id: string) => Promise<unknown>,
    msg: string,
  ) =>
    mutateEntries(async () => {
      const optimistic = !entriesQuery.isPlaceholderData;
      const snapshot = entries;
      if (optimistic) optimisticStatus(new Set([id]), status);
      try {
        await act(id);
      } catch (e) {
        if (optimistic) queryClient.setQueryData(entriesKey, snapshot);
        throw e;
      }
      toast.success(msg);
    });

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
            <Button type="button" onClick={() => setConfirmBulk('publish')} disabled={busy}>
              Publish selected
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setConfirmBulk('unpublish')}
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

      {bulkFailures && bulkFailures.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>
            {bulkFailures.length} {bulkFailures.length === 1 ? 'entry' : 'entries'} failed
          </AlertTitle>
          <AlertDescription>
            <ul className="space-y-0.5">
              {bulkFailures.map((f) => (
                <li key={f.id}>
                  <span className="font-medium">{f.title}</span>
                  {f.error ? `: ${f.error}` : ''}
                </li>
              ))}
            </ul>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => setBulkFailures(null)}
            >
              Dismiss
            </Button>
          </AlertDescription>
        </Alert>
      )}

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
              <TableHead className="w-8">
                <Checkbox
                  aria-label="Select all entries"
                  checked={entries.length > 0 && entries.every((e) => picked.has(e.id))}
                  onCheckedChange={(c) =>
                    setPicked(c === true ? new Set(entries.map((e) => e.id)) : new Set())
                  }
                />
              </TableHead>
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
                    {e.status !== 'published' && (
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
                    )}
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

      <AlertDialog
        open={confirmBulk !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmBulk(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmBulk === 'publish' ? 'Publish' : 'Unpublish'} {picked.size}{' '}
              {picked.size === 1 ? 'entry' : 'entries'}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmBulk === 'publish'
                ? 'The current draft of each selected entry goes live on the delivery API.'
                : 'Each selected entry is removed from the delivery API and returns to draft.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as is</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={() => {
                const action = confirmBulk;
                setConfirmBulk(null);
                if (action === 'publish') void bulk('publish', 'Published', 'published');
                else if (action === 'unpublish') void bulk('unpublish', 'Unpublished', 'draft');
              }}
            >
              {confirmBulk === 'publish' ? 'Publish entries' : 'Unpublish entries'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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

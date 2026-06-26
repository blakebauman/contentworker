import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { PreviewEntry } from '@/lib/management';
import type { Release, ReleaseWithItems, ScheduledAction } from '@cw/domain';
import { CalendarClock, PackageOpen, Rocket, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import { useToast } from '../lib/toast.js';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '—');

/** Local datetime → ISO, defaulting to one hour out for the picker initial value. */
function defaultScheduleLocal(): string {
  const d = new Date(Date.now() + 60 * 60 * 1000);
  // datetime-local wants `YYYY-MM-DDTHH:mm` in local time.
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}

/** Releases board + scheduled-actions queue — the P12 editorial surface. */
export function Releases() {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const [releases, setReleases] = useState<Release[]>([]);
  const [scheduled, setScheduled] = useState<ScheduledAction[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(
    () =>
      run(async () => {
        setLoading(true);
        try {
          const [rels, acts] = await Promise.all([
            client.listReleases(),
            client.listScheduledActions(),
          ]);
          setReleases(rels);
          setScheduled(acts);
        } finally {
          setLoading(false);
        }
      }),
    [client, run],
  );

  useEffect(() => {
    load();
  }, [load]);

  const publishNow = (id: string) =>
    run(async () => {
      await client.publishRelease(id);
      toast.success('Release published');
      await load();
    });

  const remove = (id: string) =>
    run(async () => {
      await client.deleteRelease(id);
      toast.success('Release deleted');
      if (openId === id) setOpenId(null);
      await load();
    });

  const cancel = (id: string) =>
    run(async () => {
      await client.cancelScheduledAction(id);
      toast.success('Scheduled action canceled');
      await load();
    });

  const pendingCount = scheduled.filter((a) => a.status === 'pending').length;

  return (
    <div className="space-y-4">
      <PageHeader title="Releases" description="Bundle entries and ship them atomically.">
        <Button type="button" onClick={() => setCreating(true)} disabled={busy}>
          + New release
        </Button>
      </PageHeader>

      <Tabs defaultValue="releases">
        <TabsList>
          <TabsTrigger value="releases">Releases</TabsTrigger>
          <TabsTrigger value="scheduled">
            Scheduled
            {pendingCount > 0 && (
              <Badge variant="secondary" className="ml-2">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="releases" className="mt-4">
          {loading ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-40 w-full" />
              ))}
            </div>
          ) : releases.length === 0 ? (
            <EmptyState
              icon={PackageOpen}
              title="No releases yet"
              description="Group entries into a release to publish them together at one moment."
            >
              <Button type="button" onClick={() => setCreating(true)}>
                Create release
              </Button>
            </EmptyState>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {releases.map((r) => (
                <Card key={r.id} className="flex flex-col">
                  <CardHeader>
                    <div className="flex items-start justify-between gap-2">
                      <CardTitle className="truncate">{r.title}</CardTitle>
                      <StatusBadge status={r.status} />
                    </div>
                    {r.description && (
                      <CardDescription className="line-clamp-2">{r.description}</CardDescription>
                    )}
                  </CardHeader>
                  <CardContent className="flex-1 text-muted-foreground text-sm">
                    Created {fmt(r.createdAt)}
                    {r.publishedAt && <div>Published {fmt(r.publishedAt)}</div>}
                  </CardContent>
                  <CardFooter className="gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setOpenId(r.id)}
                    >
                      Open
                    </Button>
                    {r.status === 'open' && (
                      <Button
                        type="button"
                        size="sm"
                        onClick={() => publishNow(r.id)}
                        disabled={busy}
                      >
                        <Rocket className="size-4" />
                        Publish
                      </Button>
                    )}
                    {r.status !== 'published' && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="ml-auto size-8"
                        aria-label="Delete release"
                        onClick={() => remove(r.id)}
                        disabled={busy}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </CardFooter>
                </Card>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="scheduled" className="mt-4">
          {loading ? (
            <Skeleton className="h-40 w-full" />
          ) : scheduled.length === 0 ? (
            <EmptyState
              icon={CalendarClock}
              title="Nothing scheduled"
              description="Schedule a release or entry to publish automatically at a future time."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Action</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-20" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {scheduled.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell className="capitalize">{a.action}</TableCell>
                    <TableCell>
                      <span className="text-muted-foreground">{a.entityType}</span>{' '}
                      <code className="text-xs">{a.entityId.slice(0, 8)}</code>
                    </TableCell>
                    <TableCell>{fmt(a.scheduledFor)}</TableCell>
                    <TableCell>
                      <StatusBadge status={a.status} />
                    </TableCell>
                    <TableCell>
                      {a.status === 'pending' && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => cancel(a.id)}
                          disabled={busy}
                        >
                          <X className="size-4" />
                          Cancel
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>
      </Tabs>

      <CreateReleaseDialog
        open={creating}
        onOpenChange={setCreating}
        onCreate={(input) =>
          run(async () => {
            const created = await client.createRelease(input);
            setCreating(false);
            toast.success('Release created');
            await load();
            setOpenId(created.id);
          })
        }
        busy={busy}
      />

      <ReleaseDetailSheet releaseId={openId} onClose={() => setOpenId(null)} onChanged={load} />
    </div>
  );
}

function CreateReleaseDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreate: (input: { title: string; description?: string }) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');

  // Reset fields each time the dialog opens.
  useEffect(() => {
    if (props.open) {
      setTitle('');
      setDescription('');
    }
  }, [props.open]);

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New release</DialogTitle>
          <DialogDescription>Name the release; add entries after creating it.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="release-title">Title</Label>
            <Input
              id="release-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Spring campaign"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="release-desc">Description</Label>
            <Input
              id="release-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!title.trim() || props.busy}
            onClick={() =>
              props.onCreate({ title: title.trim(), description: description.trim() || undefined })
            }
          >
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Detail panel for one release: members, add/remove, publish, and scheduling. */
function ReleaseDetailSheet(props: {
  releaseId: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const [detail, setDetail] = useState<ReleaseWithItems | null>(null);
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [pick, setPick] = useState('');
  const [when, setWhen] = useState(defaultScheduleLocal);

  const load = useCallback(
    (id: string) =>
      run(async () => {
        const [d, all] = await Promise.all([client.getRelease(id), client.listEntries()]);
        setDetail(d);
        setEntries(all);
      }),
    [client, run],
  );

  useEffect(() => {
    if (props.releaseId) {
      setPick('');
      load(props.releaseId);
    } else {
      setDetail(null);
    }
  }, [props.releaseId, load]);

  const refresh = async () => {
    if (props.releaseId) await load(props.releaseId);
    props.onChanged();
  };

  const id = props.releaseId;
  const open = !!id;
  const release = detail?.release;
  const items = detail?.items ?? [];
  const memberIds = new Set(items.map((i) => i.entityId));
  const candidates = entries.filter((e) => !memberIds.has(e.id));
  const editable = release?.status === 'open';

  const addEntry = () =>
    run(async () => {
      if (!id || !pick) return;
      await client.addEntryToRelease(id, { entityId: pick });
      setPick('');
      toast.success('Entry added');
      await refresh();
    });

  const removeEntry = (entityId: string) =>
    run(async () => {
      if (!id) return;
      await client.removeEntryFromRelease(id, entityId);
      await refresh();
    });

  const publishNow = () =>
    run(async () => {
      if (!id) return;
      await client.publishRelease(id);
      toast.success('Release published');
      props.onClose();
      props.onChanged();
    });

  const schedule = () =>
    run(async () => {
      if (!id) return;
      await client.scheduleAction({
        action: 'publish',
        entityType: 'Release',
        entityId: id,
        scheduledFor: new Date(when).toISOString(),
      });
      toast.success('Release scheduled');
      props.onClose();
      props.onChanged();
    });

  return (
    <Sheet open={open} onOpenChange={(o) => !o && props.onClose()}>
      <SheetContent side="right" className="flex w-full flex-col overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{release?.title ?? 'Release'}</SheetTitle>
          <SheetDescription>
            {release
              ? `${items.length} member${items.length === 1 ? '' : 's'} · ${release.status}`
              : 'Loading…'}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-6">
          {editable && (
            <div className="flex items-end gap-2">
              <div className="flex-1 space-y-1.5">
                <Label>Add entry</Label>
                <Select value={pick} onValueChange={setPick}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick an entry…" />
                  </SelectTrigger>
                  <SelectContent>
                    {candidates.length === 0 ? (
                      <SelectItem value="__none" disabled>
                        No more entries
                      </SelectItem>
                    ) : (
                      candidates.map((e) => (
                        <SelectItem key={e.id} value={e.id}>
                          {e.contentType} · {e.id.slice(0, 8)} ({e.status})
                        </SelectItem>
                      ))
                    )}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" onClick={addEntry} disabled={!pick || busy}>
                Add
              </Button>
            </div>
          )}

          <div className="space-y-2">
            <Label>Members</Label>
            {items.length === 0 ? (
              <p className="text-muted-foreground text-sm">No entries in this release yet.</p>
            ) : (
              <ul className="divide-y rounded-md border">
                {items.map((it) => (
                  <li
                    key={it.entityId}
                    className="flex items-center justify-between gap-2 px-3 py-2"
                  >
                    <div className="min-w-0">
                      <code className="text-xs">{it.entityId.slice(0, 12)}</code>
                      <Badge variant="outline" className="ml-2 capitalize">
                        {it.action}
                      </Badge>
                    </div>
                    {editable && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        aria-label="Remove entry"
                        onClick={() => removeEntry(it.entityId)}
                        disabled={busy}
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {editable && (
            <div className="space-y-3 border-t pt-4">
              <Button
                type="button"
                className="w-full"
                onClick={publishNow}
                disabled={items.length === 0 || busy}
              >
                <Rocket className="size-4" />
                Publish now
              </Button>
              <div className="space-y-1.5">
                <Label htmlFor="schedule-when">Or schedule for</Label>
                <div className="flex gap-2">
                  <Input
                    id="schedule-when"
                    type="datetime-local"
                    value={when}
                    onChange={(e) => setWhen(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="outline"
                    onClick={schedule}
                    disabled={items.length === 0 || !when || busy}
                  >
                    <CalendarClock className="size-4" />
                    Schedule
                  </Button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

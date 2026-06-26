import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { EntryVersion } from '@cw/domain';
import { History, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import type { VersionDiff } from '../lib/management.js';
import { useToast } from '../lib/toast.js';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleString() : '');
const show = (v: unknown): string =>
  v === undefined || v === null ? '—' : typeof v === 'string' ? v : JSON.stringify(v);

/**
 * Timeline of an entry's saved versions with diff-against-current and restore.
 * Restore appends a NEW version carrying the old fields, so history is never
 * rewritten — after it runs, the parent reloads the form via `onRestored`.
 */
export function VersionHistory(props: {
  entryId: string;
  /** Current draft version, to flag "current" and pick a diff baseline. */
  currentVersion: number;
  /** Published version (if any), to flag "live". */
  publishedVersion?: number | null;
  onRestored: () => void;
}) {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const [versions, setVersions] = useState<EntryVersion[]>([]);
  const [diff, setDiff] = useState<VersionDiff | null>(null);
  const [diffWith, setDiffWith] = useState<number | null>(null);

  const load = useCallback(
    () => run(async () => setVersions(await client.listVersions(props.entryId))),
    [client, run, props.entryId],
  );
  useEffect(() => {
    load();
  }, [load]);

  const toggleDiff = (version: number) =>
    run(async () => {
      if (diffWith === version) {
        setDiff(null);
        setDiffWith(null);
        return;
      }
      setDiff(await client.diffVersions(props.entryId, version, props.currentVersion));
      setDiffWith(version);
    });

  const restore = (version: number) =>
    run(async () => {
      await client.restoreVersion(props.entryId, version);
      toast.success(`Restored version ${version} as a new draft`);
      setDiff(null);
      setDiffWith(null);
      await load();
      props.onRestored();
    });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <History className="size-4" />
          Version history
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {versions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No versions yet.</p>
        ) : (
          <ul className="space-y-1">
            {versions.map((v) => {
              const isCurrent = v.version === props.currentVersion;
              const isPublished = v.version === props.publishedVersion;
              return (
                <li key={v.version} className="rounded-md border px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">v{v.version}</span>
                      {isCurrent && <Badge variant="secondary">current</Badge>}
                      {isPublished && <Badge variant="success">live</Badge>}
                      <span className="text-muted-foreground text-xs">{fmt(v.createdAt)}</span>
                    </div>
                    <div className="flex items-center gap-1">
                      {!isCurrent && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => toggleDiff(v.version)}
                          disabled={busy}
                        >
                          {diffWith === v.version ? 'Hide diff' : 'Diff'}
                        </Button>
                      )}
                      {!isCurrent && (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => restore(v.version)}
                          disabled={busy}
                        >
                          <RotateCcw className="size-3.5" />
                          Restore
                        </Button>
                      )}
                    </div>
                  </div>

                  {diffWith === v.version && diff && (
                    <div className="mt-2 space-y-1 border-t pt-2">
                      <p className="text-muted-foreground text-xs">
                        v{diff.from} → v{diff.to} (current)
                      </p>
                      {diff.changes.filter((c) => c.kind !== 'unchanged').length === 0 ? (
                        <p className="text-muted-foreground text-sm">No field changes.</p>
                      ) : (
                        diff.changes
                          .filter((c) => c.kind !== 'unchanged')
                          .map((c) => (
                            <div key={c.field} className="text-sm">
                              <span className="font-medium">{c.field}</span>{' '}
                              <Badge variant="outline" className="capitalize">
                                {c.kind}
                              </Badge>
                              <div className="grid grid-cols-2 gap-2 text-xs">
                                <span
                                  className={cn(
                                    'truncate text-muted-foreground',
                                    c.kind === 'removed' && 'text-destructive',
                                  )}
                                >
                                  {show(c.before).slice(0, 120)}
                                </span>
                                <span className="truncate">{show(c.after).slice(0, 120)}</span>
                              </div>
                            </div>
                          ))
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

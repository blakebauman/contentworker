import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import { TriangleAlert } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ManagementClient, PreviewEntry } from '../lib/management.js';

/** A single field's draft-vs-published comparison. */
interface FieldDelta {
  readonly apiId: string;
  readonly published: unknown;
  readonly draft: unknown;
  readonly changed: boolean;
}

const show = (v: unknown): string => {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
};

/**
 * Compares an entry's current draft against its published version. Draft fields
 * come from Preview (localized shape), published from Delivery (locale-collapsed,
 * links embedded) — so we unwrap the draft to the connection locale before diffing.
 */
export function EntryDiff(props: {
  client: ManagementClient;
  entry: PreviewEntry;
  locale: string;
}) {
  const { client, entry, locale } = props;
  const [deltas, setDeltas] = useState<FieldDelta[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const published = await client.getPublished(entry.id);
        if (!live) return;
        const keys = new Set([...Object.keys(entry.fields), ...Object.keys(published.fields)]);
        const rows: FieldDelta[] = [];
        for (const apiId of keys) {
          const raw = entry.fields[apiId];
          const draft =
            raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[locale] : raw;
          const pub = published.fields[apiId];
          rows.push({
            apiId,
            draft,
            published: pub,
            changed: JSON.stringify(draft ?? null) !== JSON.stringify(pub ?? null),
          });
        }
        setDeltas(rows.sort((a, b) => Number(b.changed) - Number(a.changed)));
      } catch (e) {
        // A draft that was never published has no delivery row (404) — say so plainly.
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, entry, locale]);

  const changedCount = deltas?.filter((d) => d.changed).length ?? 0;

  return (
    <div className="space-y-3">
      {!error && (
        <p className="text-sm text-muted-foreground">
          {deltas ? `${changedCount} field${changedCount === 1 ? '' : 's'} changed` : 'Comparing…'}
        </p>
      )}
      {error && (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>No published version</AlertTitle>
          <AlertDescription>
            This entry hasn’t been published yet, so there’s nothing to compare against.
          </AlertDescription>
        </Alert>
      )}
      {deltas && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-32">Field</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Draft</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {deltas.map((d) => (
              <TableRow key={d.apiId} className={cn(d.changed && 'bg-warning/5')}>
                <TableCell>
                  {d.changed && <span className="text-primary">● </span>}
                  {d.apiId}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {show(d.published).slice(0, 200)}
                </TableCell>
                <TableCell>{show(d.draft).slice(0, 200)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

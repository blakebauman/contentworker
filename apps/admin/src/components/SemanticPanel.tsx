import { CollapsibleCard } from '@/components/CollapsibleCard';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, GitCompare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';
import type { SearchHit } from '../lib/management.js';
import type { PickOption } from './EntryForm.js';

/**
 * Content Semantics for an entry: surfaces near-duplicates (a warning) and
 * semantically related entries, both backed by the pgvector index. Only
 * published entries are indexed, so results reflect shipped content.
 */
export function SemanticPanel(props: {
  entryId: string;
  /** Known entries (from the editor's pickers) to render titles and links
   * instead of raw ids. Best-effort; unknown ids fall back to the snippet. */
  entries?: readonly PickOption[];
}) {
  const { client } = useClient();
  const [related, setRelated] = useState<SearchHit[] | null>(null);
  const [dupes, setDupes] = useState<SearchHit[]>([]);

  useEffect(() => {
    let live = true;
    setRelated(null);
    setDupes([]);
    Promise.all([
      client.relatedEntries(props.entryId, 5),
      client.findDuplicates(props.entryId, 0.9),
    ])
      .then(([r, d]) => {
        if (!live) return;
        setRelated(r);
        setDupes(d);
      })
      .catch(() => {
        if (live) setRelated([]);
      });
    return () => {
      live = false;
    };
  }, [client, props.entryId]);

  const pct = (score: number) => `${Math.round(score * 100)}%`;
  const known = new Map((props.entries ?? []).map((e) => [e.id, e]));

  const hitTitle = (hit: SearchHit) =>
    known.get(hit.entryId)?.label ?? (hit.snippet || `Entry ${hit.entryId.slice(0, 8)}…`);

  const hitLink = (hit: SearchHit) => {
    const entry = known.get(hit.entryId);
    return entry?.contentType ? `/content/${entry.contentType}/${hit.entryId}` : null;
  };

  return (
    <CollapsibleCard
      defaultOpen
      title={
        <>
          <GitCompare className="size-4 text-primary" /> Content semantics
        </>
      }
      description="Related entries and near-duplicates, from the vector index."
      contentClassName="space-y-3"
    >
      {dupes.length > 0 && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Possible duplicate{dupes.length > 1 ? 's' : ''}</AlertTitle>
          <AlertDescription>
            <ul className="space-y-0.5">
              {dupes.map((d) => {
                const to = hitLink(d);
                return (
                  <li key={d.entryId} className="text-xs">
                    {to ? (
                      <Link to={to} className="underline underline-offset-2">
                        {hitTitle(d)}
                      </Link>
                    ) : (
                      <span>{hitTitle(d)}</span>
                    )}{' '}
                    · {pct(d.score)} similar
                  </li>
                );
              })}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {related === null ? (
        <p className="text-muted-foreground text-sm">Loading…</p>
      ) : related.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          No related entries yet (publish entries to index them).
        </p>
      ) : (
        <ul className="space-y-1.5">
          {related.map((r) => {
            const to = hitLink(r);
            return (
              <li key={r.entryId} className="flex items-center justify-between gap-2">
                {to ? (
                  <Link
                    to={to}
                    className="truncate text-sm underline-offset-2 hover:underline"
                    title={r.snippet}
                  >
                    {hitTitle(r)}
                  </Link>
                ) : (
                  <span className="truncate text-sm" title={r.snippet}>
                    {hitTitle(r)}
                  </span>
                )}
                <Badge variant="outline" className="shrink-0">
                  {pct(r.score)}
                </Badge>
              </li>
            );
          })}
        </ul>
      )}
    </CollapsibleCard>
  );
}

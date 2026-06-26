import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { AlertTriangle, GitCompare } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import type { SearchHit } from '../lib/management.js';

/**
 * Content Semantics for an entry: surfaces near-duplicates (a warning) and
 * semantically related entries, both backed by the pgvector index. Only
 * published entries are indexed, so results reflect shipped content.
 */
export function SemanticPanel(props: { entryId: string }) {
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

  return (
    <Card>
      <CardHeader>
        <h2 className="flex items-center gap-1.5 font-heading font-medium text-base">
          <GitCompare className="size-4 text-primary" /> Content semantics
        </h2>
        <p className="text-muted-foreground text-sm">
          Related entries and near-duplicates, from the vector index.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {dupes.length > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertTitle>Possible duplicate{dupes.length > 1 ? 's' : ''}</AlertTitle>
            <AlertDescription>
              <ul className="space-y-0.5">
                {dupes.map((d) => (
                  <li key={d.entryId} className="font-mono text-xs">
                    {d.entryId} · {pct(d.score)}
                  </li>
                ))}
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
            {related.map((r) => (
              <li key={r.entryId} className="flex items-center justify-between gap-2">
                <span className="truncate text-sm" title={r.snippet}>
                  {r.snippet || r.entryId}
                </span>
                <Badge variant="outline" className="shrink-0">
                  {pct(r.score)}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

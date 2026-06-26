import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Radio } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useClient } from '../../lib/client-context.js';

type LiveItem = { type: string; entryId?: string; at: number };

/**
 * Live Content API feed: streams published-content changes over SSE (via fetch
 * streaming, so the bearer token is sent). Shows the most recent events; the
 * connection closes when the card unmounts.
 */
export function LiveActivityCard() {
  const { client } = useClient();
  const [items, setItems] = useState<LiveItem[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const ac = new AbortController();
    setConnected(true);
    client
      .subscribeLive((e) => {
        const data = e.data as { entryId?: string } | undefined;
        setItems((prev) =>
          [{ type: e.type, entryId: data?.entryId, at: Date.now() }, ...prev].slice(0, 20),
        );
      }, ac.signal)
      .catch(() => setConnected(false))
      .finally(() => setConnected(false));
    return () => ac.abort();
  }, [client]);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 font-heading font-medium text-base">
          <Radio className={`size-4 ${connected ? 'text-emerald-500' : 'text-muted-foreground'}`} />
          Live activity
        </h2>
        <Badge variant={connected ? 'success' : 'outline'}>{connected ? 'live' : 'idle'}</Badge>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Waiting for published-content changes… publish an entry to see it stream in.
          </p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((it) => (
              <li
                key={`${it.at}:${it.entryId ?? it.type}`}
                className="flex items-center gap-2 text-sm"
              >
                <Badge variant="outline" className="text-[10px]">
                  {it.type}
                </Badge>
                {it.entryId && (
                  <span className="truncate font-mono text-muted-foreground text-xs">
                    {it.entryId}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

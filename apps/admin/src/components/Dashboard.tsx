import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useCallback, useEffect, useState } from 'react';
import type { AgentRun, ManagementClient, SearchHit, UsageSummary } from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/** Agent/cost dashboard + semantic search over published content. */
export function Dashboard(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [usage, setUsage] = useState<UsageSummary>();

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      const [r, u] = await Promise.all([client.listAgentRuns(), client.agentUsage()]);
      setRuns(r);
      setUsage(u);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const runSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      setHits(await client.search(query));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>

      {/* Cost ledger */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Agent runs" value={usage?.runs} />
        <Stat label="Input tokens" value={usage?.inputTokens?.toLocaleString()} />
        <Stat label="Output tokens" value={usage?.outputTokens?.toLocaleString()} />
      </div>

      {/* Semantic search */}
      <form className="flex items-center gap-2" onSubmit={runSearch}>
        <Input
          placeholder="Semantic search published content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </Button>
      </form>
      {hits.length > 0 && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Score</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Snippet</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {hits.map((h) => (
              <TableRow key={h.entryId}>
                <TableCell>{h.score.toFixed(3)}</TableCell>
                <TableCell className="text-muted-foreground">{h.entryId}</TableCell>
                <TableCell>{h.snippet.slice(0, 120)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {/* Agent runs */}
      <div className="space-y-3">
        <h2 className="text-base font-semibold">Recent agent runs</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Workflow</TableHead>
              <TableHead>Entry</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Tokens (in/out)</TableHead>
              <TableHead>When</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell>{r.workflow}</TableCell>
                <TableCell className="text-muted-foreground">{r.entryId}</TableCell>
                <TableCell>
                  <StatusBadge status={r.status} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {r.inputTokens}/{r.outputTokens}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {new Date(r.createdAt).toLocaleString()}
                </TableCell>
              </TableRow>
            ))}
            {runs.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No agent runs yet (enable AGENTS_ENRICH on the worker).
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Stat(props: { label: string; value: number | string | undefined }) {
  return (
    <Card>
      <CardContent>
        <div className="text-sm text-muted-foreground">{props.label}</div>
        <div className="text-3xl font-bold">{props.value ?? '—'}</div>
      </CardContent>
    </Card>
  );
}

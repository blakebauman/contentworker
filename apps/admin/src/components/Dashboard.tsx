import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { ConnectionAccessCard } from '@/components/dashboard/ConnectionAccessCard';
import { ThroughputCard } from '@/components/dashboard/ThroughputCard';
import { UsageByWorkflowCard } from '@/components/dashboard/UsageByWorkflowCard';
import { UsageTrendCard } from '@/components/dashboard/UsageTrendCard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Bot, SearchX } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { AgentRun, ManagementClient, SearchHit } from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/** Agent/cost dashboard + semantic search over published content. */
export function Dashboard(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [runs, setRuns] = useState<AgentRun[]>([]);

  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);

  const load = useCallback(async () => {
    try {
      setRuns(await client.listAgentRuns());
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
      setSearched(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Dashboard"
        description="Agent activity and semantic search across your published content."
      />

      {/* Usage analytics + access */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <UsageTrendCard runs={runs} />
        <ThroughputCard runs={runs} />
        <ConnectionAccessCard />
      </div>

      <UsageByWorkflowCard runs={runs} />

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
      {searched && hits.length === 0 && (
        <EmptyState
          icon={SearchX}
          title="No matches"
          description="No published content matched that query. Try different wording."
        />
      )}

      {/* Agent runs */}
      <div id="agent-runs" className="space-y-3 scroll-mt-20">
        <h2 className="text-base font-semibold">Recent agent runs</h2>
        {runs.length === 0 ? (
          <EmptyState
            icon={Bot}
            title="No agent runs yet"
            description="Enable AGENTS_ENRICH on the worker and runs will appear here as content is published."
          />
        ) : (
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
                  <TableCell className="text-muted-foreground">{r.entryId || '—'}</TableCell>
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
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}

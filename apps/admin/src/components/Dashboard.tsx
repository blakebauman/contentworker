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

  const card: React.CSSProperties = {
    border: '1px solid var(--border)',
    borderRadius: 8,
    padding: 16,
    minWidth: 130,
  };

  return (
    <>
      <h1 className="h">Dashboard</h1>

      {/* Cost ledger */}
      <div className="row" style={{ gap: 12, marginBottom: 20 }}>
        <div style={card}>
          <div className="muted">Agent runs</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>{usage?.runs ?? '—'}</div>
        </div>
        <div style={card}>
          <div className="muted">Input tokens</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            {usage?.inputTokens?.toLocaleString() ?? '—'}
          </div>
        </div>
        <div style={card}>
          <div className="muted">Output tokens</div>
          <div style={{ fontSize: 28, fontWeight: 700 }}>
            {usage?.outputTokens?.toLocaleString() ?? '—'}
          </div>
        </div>
      </div>

      {/* Semantic search */}
      <form className="row" onSubmit={runSearch} style={{ marginBottom: 8 }}>
        <input
          placeholder="Semantic search published content…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>
      {hits.length > 0 && (
        <table style={{ marginBottom: 20 }}>
          <thead>
            <tr>
              <th style={{ width: 80 }}>Score</th>
              <th>Entry</th>
              <th>Snippet</th>
            </tr>
          </thead>
          <tbody>
            {hits.map((h) => (
              <tr key={h.entryId}>
                <td>{h.score.toFixed(3)}</td>
                <td className="muted">{h.entryId}</td>
                <td>{h.snippet.slice(0, 120)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Agent runs */}
      <h2 className="h" style={{ fontSize: 15 }}>
        Recent agent runs
      </h2>
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Entry</th>
            <th>Status</th>
            <th>Tokens (in/out)</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id}>
              <td>{r.workflow}</td>
              <td className="muted">{r.entryId}</td>
              <td>
                <span className={`badge ${r.status === 'completed' ? 'published' : 'draft'}`}>
                  {r.status}
                </span>
              </td>
              <td className="muted">
                {r.inputTokens}/{r.outputTokens}
              </td>
              <td className="muted">{new Date(r.createdAt).toLocaleString()}</td>
            </tr>
          ))}
          {runs.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No agent runs yet (enable AGENTS_ENRICH on the worker).
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}

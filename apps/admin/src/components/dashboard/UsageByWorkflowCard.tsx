import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { type ChartConfig, ChartContainer } from '@/components/ui/chart';
import { Bot } from 'lucide-react';
import { Bar, BarChart } from 'recharts';
import type { AgentRun } from '../../lib/management.js';
import { type WorkflowUsage, formatTokens, usageByWorkflow } from '../../lib/usage.js';

const sparkConfig = {
  runs: { label: 'Runs', color: 'var(--primary)' },
} satisfies ChartConfig;

/**
 * "Usage by Workflow" — token spend broken down per agent workflow, each row
 * showing run count, total tokens, and a mini per-day activity sparkline.
 * Mirrors the shadcn dividend-income card (holding → per-quarter bars).
 */
export function UsageByWorkflowCard(props: { runs: readonly AgentRun[] }) {
  const rows = usageByWorkflow(props.runs, 7);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Usage by Workflow</CardTitle>
        <p className="text-sm text-muted-foreground">Token spend across agent workflows.</p>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
            <Bot className="size-6" />
            No agent activity yet.
          </div>
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((row) => (
              <WorkflowRow key={row.workflow} row={row} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function WorkflowRow(props: { row: WorkflowUsage }) {
  const { row } = props;
  const data = row.spark.map((runs, i) => ({ i, runs }));
  return (
    <li className="flex items-center justify-between gap-4 py-3">
      <div className="min-w-0">
        <div className="font-medium capitalize">{row.workflow}</div>
        <div className="text-xs text-muted-foreground">
          {row.runs} {row.runs === 1 ? 'run' : 'runs'}
        </div>
      </div>

      {/* Mini per-day activity sparkline (last 7 days), hidden on narrow cards. */}
      <ChartContainer config={sparkConfig} className="hidden aspect-auto h-8 w-28 flex-1 sm:block">
        <BarChart data={data} margin={{ top: 2, bottom: 0, left: 0, right: 0 }}>
          <Bar dataKey="runs" fill="var(--color-runs)" radius={1} />
        </BarChart>
      </ChartContainer>

      <div className="shrink-0 text-right tabular-nums">
        <div className="font-semibold">{formatTokens(row.totalTokens)}</div>
        <div className="text-xs text-muted-foreground">tokens</div>
      </div>
    </li>
  );
}

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from '@/components/ui/chart';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, XAxis } from 'recharts';
import type { AgentRun } from '../../lib/management.js';
import { bucketRunsByDay, formatTokens, tokenGrowth } from '../../lib/usage.js';

const chartConfig = {
  totalTokens: { label: 'Tokens', color: 'var(--primary)' },
} satisfies ChartConfig;

/**
 * "AI Usage Trend" — total tokens over the last 14 days as a gradient area
 * chart, with a week-over-week growth badge. Mirrors the shadcn analytics-card
 * pattern, fed by agent-run history (input + output tokens bucketed by day).
 */
export function UsageTrendCard(props: { runs: readonly AgentRun[] }) {
  const data = bucketRunsByDay(props.runs, 14);
  const total = data.reduce((s, b) => s + b.totalTokens, 0);
  const { pct } = tokenGrowth(props.runs, 7);
  const up = (pct ?? 0) >= 0;
  const range = data.length > 0 ? `${data[0]!.label} – ${data[data.length - 1]!.label}` : '';

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-sm font-medium text-muted-foreground">AI Usage Trend</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-3xl font-bold tabular-nums">{formatTokens(total)}</span>
          {pct !== null && (
            <Badge variant={up ? 'success' : 'destructive'} className="gap-1">
              {up ? <TrendingUp className="size-3" /> : <TrendingDown className="size-3" />}
              {up ? '+' : ''}
              {pct}%
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground">tokens · last 14 days</p>
      </CardHeader>
      <CardContent>
        <ChartContainer config={chartConfig} className="aspect-auto h-30 w-full">
          <AreaChart accessibilityLayer data={data} margin={{ left: 12, right: 12 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
            />
            <ChartTooltip cursor={false} content={<ChartTooltipContent indicator="line" />} />
            <defs>
              <linearGradient id="fill-usage-trend" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="var(--color-totalTokens)" stopOpacity={0.8} />
                <stop offset="95%" stopColor="var(--color-totalTokens)" stopOpacity={0.1} />
              </linearGradient>
            </defs>
            <Area
              dataKey="totalTokens"
              type="natural"
              fill="url(#fill-usage-trend)"
              fillOpacity={0.4}
              stroke="var(--color-totalTokens)"
              strokeWidth={2}
            />
          </AreaChart>
        </ChartContainer>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          {pct !== null ? (
            <>
              {up ? <TrendingUp className="size-4" /> : <TrendingDown className="size-4" />}
              {up ? 'Up' : 'Down'} {Math.abs(pct)}% week over week
            </>
          ) : (
            <span>{range}</span>
          )}
        </div>
        <Button variant="outline" size="sm" asChild className="w-full">
          <a href="#agent-runs">View usage</a>
        </Button>
      </CardFooter>
    </Card>
  );
}

import { Badge } from '@/components/ui/badge';

// Status strings used across entries, assets, API keys, webhooks and agent runs.
// "Healthy" states render green (success), in-progress/paused states render amber
// (warning). The visible text stays the raw status — e2e/tests assert on it.
const SUCCESS = new Set(['published', 'active', 'completed']);

export function StatusBadge(props: { status: string; label?: string }) {
  const variant = SUCCESS.has(props.status) ? 'success' : 'warning';
  return <Badge variant={variant}>{props.label ?? props.status}</Badge>;
}

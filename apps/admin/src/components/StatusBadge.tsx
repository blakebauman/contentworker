import { Badge } from '@/components/ui/badge';

// Status strings used across entries, assets, API keys, webhooks and agent runs.
// "Healthy" states render green (success); untouched drafts render neutral
// (outline) so an editor can tell them from published-then-edited entries at a
// glance (DESIGN.md: draft = outline, changed = warning); everything else —
// in-progress, paused, changed — renders amber (warning). The visible text
// stays the raw status — e2e/tests assert on it.
const SUCCESS = new Set(['published', 'active', 'completed']);
const NEUTRAL = new Set(['draft']);

export function StatusBadge(props: { status: string; label?: string }) {
  const variant = SUCCESS.has(props.status)
    ? 'success'
    : NEUTRAL.has(props.status)
      ? 'outline'
      : 'warning';
  return <Badge variant={variant}>{props.label ?? props.status}</Badge>;
}

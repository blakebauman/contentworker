import type { DomainEvent } from '@cw/domain';
import type { Cache, FunctionInvoker, SearchIndex, WebhookSender } from '@cw/ports';
import type { AppContext } from '../context.js';
import { invokeFunctionsForEvent } from '../functions.js';
import {
  type RagDeps,
  extractTextByLocale,
  indexEntryEmbeddings,
  removeEntryEmbeddings,
  runReindexJob,
} from '../rag.js';

/** Reverse-reference walk bound: embed chains deeper than this stay stale
 *  until their own next publish (cycle-safe either way via the visited set). */
export const MAX_INVALIDATION_DEPTH = 5;
/** Hard ceiling on entries invalidated per event (pathological fan-in guard). */
export const MAX_INVALIDATION_ENTRIES = 500;

export interface DispatchDeps {
  readonly sender: WebhookSender;
  /** Optional — when present, delivery cache tags are invalidated. */
  readonly cache?: Cache;
  /** Optional — when present, entries are embedded on publish (RAG). */
  readonly rag?: RagDeps;
  /** Optional — when present, matching user functions are invoked on each event. */
  readonly invoker?: FunctionInvoker;
  /** Optional observer for webhook delivery outcomes (host-side metrics). */
  readonly onWebhookDelivery?: (result: { delivered: boolean }) => void;
  /**
   * Optional external lexical index (e.g. OpenSearch), kept fresh on
   * publish/unpublish. Independent of `rag` so lexical-at-scale works without
   * embeddings configured.
   */
  readonly searchIndex?: SearchIndex;
}

/**
 * Handles a single relayed domain event: fans it out to subscribed webhooks
 * (signed + recorded) and invalidates the delivery cache for the affected entry
 * AND every entry that embeds it (via the reverse-reference graph), so embedded
 * copies refresh on the next read. Idempotent on the event id.
 */
export async function dispatchEvent(
  ctx: AppContext,
  deps: DispatchDeps,
  event: DomainEvent,
): Promise<void> {
  const scope = event.scope;

  // Background reindex job: run one bounded slice here on the consumer; the
  // remainder (if any) is re-enqueued as a continuation event via the outbox.
  // Runs lexical-only when a SearchIndex is bound without embeddings, so a
  // reindex request never silently no-ops. Nothing else applies to this event.
  if (event.type === 'search.reindex_requested') {
    const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
    if (deps.rag || searchIndex) {
      await runReindexJob(deps.rag, ctx, event, { searchIndex });
    }
    return;
  }

  // 1. Webhook fan-out.
  const webhooks = await ctx.store.webhooks.listByTopic(scope, event.type);
  for (const webhook of webhooks) {
    const result = await deps.sender.send(webhook, event);
    deps.onWebhookDelivery?.({ delivered: result.delivered });
    await ctx.store.webhooks.recordDelivery(scope, {
      webhookId: webhook.id,
      eventId: event.id,
      status: result.delivered ? 'success' : 'failed',
      statusCode: result.statusCode,
      attempts: 1,
      error: result.error,
    });
  }

  // 2. Cache invalidation for entry events: the entry itself plus every entry
  // that transitively embeds it (A embeds B embeds C → publishing C refreshes
  // A and B), via a bounded breadth-first walk of the reverse-reference graph.
  if (deps.cache && (event.type === 'entry.published' || event.type === 'entry.unpublished')) {
    const visited = new Set<string>([event.entryId]);
    let frontier = [event.entryId];
    walk: for (let depth = 0; depth < MAX_INVALIDATION_DEPTH && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const edge of await ctx.store.references.findReverse(scope, id)) {
          if (visited.has(edge.fromEntryId)) continue;
          // Cap reached: stop querying entirely — everything already admitted
          // to `visited` still gets invalidated below.
          if (visited.size >= MAX_INVALIDATION_ENTRIES) break walk;
          visited.add(edge.fromEntryId);
          next.push(edge.fromEntryId);
        }
      }
      frontier = next;
    }
    const cache = deps.cache;
    await Promise.all([...visited].map((id) => cache.invalidateTag(cacheTag(scope, id))));
  }

  // 3. RAG: (re)embed on publish, drop vectors on unpublish.
  if (deps.rag) {
    if (event.type === 'entry.published') {
      await indexEntryEmbeddings(deps.rag, scope, {
        entryId: event.entryId,
        fields: event.fields,
        entryVersion: event.version,
      });
    } else if (event.type === 'entry.unpublished') {
      await removeEntryEmbeddings(deps.rag, scope, event.entryId);
    }
  }

  // 3b. External lexical index (when bound): mirror the publish lifecycle.
  const searchIndex = deps.searchIndex ?? deps.rag?.searchIndex;
  if (searchIndex) {
    if (event.type === 'entry.published') {
      await searchIndex.index(scope, {
        entryId: event.entryId,
        contentTypeApiId: event.contentTypeApiId,
        textByLocale: extractTextByLocale(event.fields),
        entryVersion: event.version,
      });
    } else if (event.type === 'entry.unpublished') {
      await searchIndex.remove(scope, event.entryId);
    }
  }

  // 4. User-defined functions matching this event type.
  if (deps.invoker) {
    await invokeFunctionsForEvent(ctx, deps.invoker, event);
  }
}

/** Cache tag for a delivered entry, scoped to its space + environment. */
export function cacheTag(
  scope: { spaceId: string; environmentId: string },
  entryId: string,
): string {
  return `entry:${scope.spaceId}:${scope.environmentId}:${entryId}`;
}

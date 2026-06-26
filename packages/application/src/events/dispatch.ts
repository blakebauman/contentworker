import type { DomainEvent } from '@cw/domain';
import type { Cache, FunctionInvoker, WebhookSender } from '@cw/ports';
import type { AppContext } from '../context.js';
import { invokeFunctionsForEvent } from '../functions.js';
import { type RagDeps, indexEntryEmbeddings, removeEntryEmbeddings } from '../rag.js';

export interface DispatchDeps {
  readonly sender: WebhookSender;
  /** Optional — when present, delivery cache tags are invalidated. */
  readonly cache?: Cache;
  /** Optional — when present, entries are embedded on publish (RAG). */
  readonly rag?: RagDeps;
  /** Optional — when present, matching user functions are invoked on each event. */
  readonly invoker?: FunctionInvoker;
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

  // 1. Webhook fan-out.
  const webhooks = await ctx.store.webhooks.listByTopic(scope, event.type);
  for (const webhook of webhooks) {
    const result = await deps.sender.send(webhook, event);
    await ctx.store.webhooks.recordDelivery(scope, {
      webhookId: webhook.id,
      eventId: event.id,
      status: result.delivered ? 'success' : 'failed',
      statusCode: result.statusCode,
      attempts: 1,
      error: result.error,
    });
  }

  // 2. Cache invalidation for entry events.
  if (deps.cache && (event.type === 'entry.published' || event.type === 'entry.unpublished')) {
    const tags = new Set<string>([cacheTag(scope, event.entryId)]);
    for (const edge of await ctx.store.references.findReverse(scope, event.entryId)) {
      tags.add(cacheTag(scope, edge.fromEntryId));
    }
    for (const tag of tags) await deps.cache.invalidateTag(tag);
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

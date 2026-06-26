import {
  type Entry,
  InvalidStateError,
  NotFoundError,
  type ReferenceEdge,
  type Scope,
  ValidationError,
  extractReferences,
  publish,
  unpublish,
} from '@cw/domain';
import type { ContentStoreTx, PublishedEntry } from '@cw/ports';
import type { AppContext } from './context.js';

/**
 * Publishes one entry inside an existing transaction. Writes the denormalized
 * published snapshot (the Delivery read model), materializes reference edges,
 * and appends an `entry.published` event to the outbox. Factored out of
 * {@link publishEntry} so a release can publish many entries in one transaction.
 */
export async function publishEntryTx(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  id: string,
): Promise<Entry> {
  const found = await tx.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);

  const published = publish(found.entry);

  // Materialize reference edges from the entry's link fields and verify each
  // linked entry exists in this environment (referential integrity).
  const contentType = await tx.contentTypes.get(scope, published.contentTypeApiId);
  if (!contentType) throw new NotFoundError('ContentType', published.contentTypeApiId);
  const edges = extractReferences(published.id, found.fields, contentType);
  await assertReferentialIntegrity(tx, scope, edges);

  await tx.entries.saveAggregate(scope, published);

  // Capture the entry's taxonomy associations in the published snapshot so the
  // Delivery API can serve and filter on them without a second lookup.
  const metadata = (await ctx.store.taxonomy.getEntryMetadata(scope, id)) ?? undefined;

  const snapshot: PublishedEntry = {
    entryId: published.id,
    contentTypeApiId: published.contentTypeApiId,
    version: published.currentVersion,
    fields: found.fields,
    publishedAt: ctx.clock.now().toISOString(),
    metadata,
  };
  await tx.entries.putPublished(scope, snapshot);
  await tx.references.replaceForEntry(scope, published.id, edges);

  await tx.outbox.append({
    id: ctx.ids.newId(),
    type: 'entry.published',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    entryId: published.id,
    contentTypeApiId: published.contentTypeApiId,
    version: published.currentVersion,
    fields: found.fields,
  });

  return published;
}

/** Withdraws one entry's published version inside an existing transaction. */
export async function unpublishEntryTx(
  ctx: AppContext,
  tx: ContentStoreTx,
  scope: Scope,
  id: string,
): Promise<Entry> {
  const found = await tx.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  if (found.entry.publishedVersion === null) {
    throw new InvalidStateError('Entry is not published');
  }
  const updated = unpublish(found.entry);
  await tx.entries.saveAggregate(scope, updated);
  await tx.entries.removePublished(scope, id);
  await tx.references.removeForEntry(scope, id);
  await tx.outbox.append({
    id: ctx.ids.newId(),
    type: 'entry.unpublished',
    scope,
    occurredAt: ctx.clock.now().toISOString(),
    entryId: id,
    contentTypeApiId: updated.contentTypeApiId,
  });
  return updated;
}

/**
 * Publishes an entry at its current version. Within one transaction it writes
 * the denormalized published snapshot (the Delivery read model) and appends an
 * `entry.published` event to the outbox, guaranteeing the event is enqueued iff
 * the publish commits.
 */
export async function publishEntry(ctx: AppContext, scope: Scope, id: string): Promise<Entry> {
  return ctx.store.withTransaction((tx) => publishEntryTx(ctx, tx, scope, id));
}

/** Withdraws an entry's published version and removes it from the read model. */
export async function unpublishEntry(ctx: AppContext, scope: Scope, id: string): Promise<Entry> {
  return ctx.store.withTransaction((tx) => unpublishEntryTx(ctx, tx, scope, id));
}

/**
 * Verifies that every entry-targeted reference points at an entry that exists
 * in this environment. Missing targets are reported as validation issues so an
 * entry can't be published with dangling links. (Asset targets are checked once
 * assets land in P3b.)
 */
async function assertReferentialIntegrity(
  tx: ContentStoreTx,
  scope: Scope,
  edges: readonly ReferenceEdge[],
): Promise<void> {
  const issues = [];
  for (const edge of edges) {
    if (edge.toType === 'Entry') {
      if (!(await tx.entries.get(scope, edge.toId))) {
        issues.push({
          field: edge.fromField,
          message: `Linked entry "${edge.toId}" does not exist`,
        });
      }
    } else if (edge.toType === 'Asset') {
      if (!(await tx.assets.get(scope, edge.toId))) {
        issues.push({
          field: edge.fromField,
          message: `Linked asset "${edge.toId}" does not exist`,
        });
      }
    }
  }
  if (issues.length > 0) throw new ValidationError(issues);
}

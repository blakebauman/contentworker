import { type EntryFields, type Scope, ValidationError } from '@cw/domain';
import type { AppContext } from './context.js';
import { type CreateEntryInput, createEntry } from './entries.js';
import { publishEntry, unpublishEntry } from './publishing.js';

/** Largest batch a single bulk call accepts. */
export const BULK_LIMIT = 1000;

export type BulkEntryAction = 'publish' | 'unpublish';

/** Per-item outcome — the batch never fails as a whole; failures are captured. */
export interface BulkItemResult {
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

export interface BulkSummary {
  readonly action: string;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly results: readonly BulkItemResult[];
}

function assertBatch(n: number): void {
  if (n === 0) throw new ValidationError([{ field: 'ids', message: 'No items provided' }]);
  if (n > BULK_LIMIT) {
    throw new ValidationError([{ field: 'ids', message: `Batch exceeds ${BULK_LIMIT} items` }]);
  }
}

function summarize(action: string, results: BulkItemResult[]): BulkSummary {
  const succeeded = results.filter((r) => r.ok).length;
  return { action, total: results.length, succeeded, failed: results.length - succeeded, results };
}

/**
 * Publishes or unpublishes many entries in one call. Each item is independent:
 * one failure never aborts the rest, and the per-item outcome is returned.
 */
export async function bulkEntryAction(
  ctx: AppContext,
  scope: Scope,
  action: BulkEntryAction,
  ids: readonly string[],
): Promise<BulkSummary> {
  assertBatch(ids.length);
  const run = action === 'publish' ? publishEntry : unpublishEntry;
  const results: BulkItemResult[] = [];
  for (const id of ids) {
    try {
      await run(ctx, scope, id);
      results.push({ id, ok: true });
    } catch (e) {
      results.push({ id, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summarize(action, results);
}

export interface BulkCreateItemResult {
  /** Index of the item in the request, so callers can correlate failures. */
  readonly id: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Creates many draft entries in one call. Each is validated and created
 * independently; the per-item outcome (new id or error) is returned.
 */
export async function bulkCreateEntries(
  ctx: AppContext,
  scope: Scope,
  items: readonly CreateEntryInput[],
): Promise<BulkSummary> {
  assertBatch(items.length);
  const results: BulkItemResult[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i] as { contentTypeApiId: string; fields: EntryFields };
    try {
      const { entry } = await createEntry(ctx, scope, item);
      results.push({ id: entry.id, ok: true });
    } catch (e) {
      results.push({ id: `#${i}`, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return summarize('create', results);
}

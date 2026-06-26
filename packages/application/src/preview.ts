import { NotFoundError, type Scope } from '@cw/domain';
import type { EntryQuery } from '@cw/ports';
import type { AppContext } from './context.js';
import type { RenderOptions } from './delivery.js';
import { renderFields } from './render.js';

/** A previewed entry: the current (draft) version, including its status. */
export interface PreviewedEntry {
  readonly id: string;
  readonly contentType: string;
  readonly status: string;
  readonly version: number;
  readonly fields: Record<string, unknown>;
}

async function spaceConfig(ctx: AppContext, scope: Scope) {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

/**
 * Read path for the Preview API (CPA). Serves the current/draft version of an
 * entry — what an editor sees before publishing — rather than the published
 * snapshot.
 */
export async function getPreviewEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: RenderOptions = {},
): Promise<PreviewedEntry> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const config = await spaceConfig(ctx, scope);
  return {
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    fields: renderFields(found.fields, config, opts.locale),
  };
}

export async function listPreviewEntries(
  ctx: AppContext,
  scope: Scope,
  query: EntryQuery = {},
  opts: RenderOptions = {},
): Promise<PreviewedEntry[]> {
  const config = await spaceConfig(ctx, scope);
  const locale = query.locale ?? opts.locale ?? config.defaultLocale;
  const rows = await ctx.store.entries.list(scope, { ...query, locale });
  return rows.map((found) => ({
    id: found.entry.id,
    contentType: found.entry.contentTypeApiId,
    status: found.entry.status,
    version: found.entry.currentVersion,
    fields: renderFields(found.fields, config, opts.locale),
  }));
}

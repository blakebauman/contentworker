import {
  NotFoundError,
  type Principal,
  type Scope,
  canAccessContentType,
  maskDeniedFields,
  resolveLocalizedValue,
} from '@cw/domain';
import type { LocaleConfig } from '@cw/domain';
import type { EntryQuery, PublishedEntry, SpaceConfig } from '@cw/ports';
import type { AppContext } from './context.js';
import { cacheTag } from './events/dispatch.js';

export interface RenderOptions {
  /** When set, fields are flattened to this locale with fallback. */
  readonly locale?: string;
  /** Reference resolution depth (0 = none). Bounded by MAX_INCLUDE. */
  readonly include?: number;
}

/** A delivered entry as returned to channels. Link fields may be embedded. */
export interface DeliveredEntry {
  readonly id: string;
  readonly contentType: string;
  readonly fields: Record<string, unknown>;
  readonly publishedAt: string;
  /** Taxonomy associations (tags + concepts), when the entry has any. */
  readonly metadata?: { readonly tags: readonly string[]; readonly concepts: readonly string[] };
}

const MAX_INCLUDE = 5;

async function spaceConfig(ctx: AppContext, scope: Scope): Promise<SpaceConfig> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return config;
}

const toLocaleConfig = (s: SpaceConfig): LocaleConfig => ({
  defaultLocale: s.defaultLocale,
  locales: s.locales,
  fallbacks: s.fallbacks,
});

function isEntryLink(value: unknown): value is { id: string; linkType: 'Entry' } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && l.linkType === 'Entry';
}

function isAssetLink(value: unknown): value is { id: string; linkType: 'Asset' } {
  const l = value as { id?: unknown; linkType?: unknown };
  return typeof l?.id === 'string' && l.linkType === 'Asset';
}

/**
 * Renders a published snapshot for delivery: applies locale flattening and
 * recursively embeds linked entries up to `include` depth. A `seen` set guards
 * against reference cycles — a revisited link is left as a `{ id, linkType }`
 * stub rather than recursing forever.
 */
async function render(
  ctx: AppContext,
  scope: Scope,
  snapshot: PublishedEntry,
  config: SpaceConfig,
  opts: RenderOptions,
  depth: number,
  seen: Set<string>,
  collected: Set<string>,
): Promise<DeliveredEntry> {
  collected.add(snapshot.entryId);
  const localeCfg = toLocaleConfig(config);
  const resolveValue = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(resolveValue));
    if (depth > 0 && isEntryLink(value) && !seen.has(value.id)) {
      const target = await ctx.store.entries.getPublished(scope, value.id);
      if (!target) return value; // dangling/unpublished link — leave the stub
      return render(
        ctx,
        scope,
        target,
        config,
        opts,
        depth - 1,
        new Set([...seen, value.id]),
        collected,
      );
    }
    if (depth > 0 && isAssetLink(value)) {
      const asset = await ctx.store.assets.getPublished(scope, value.id);
      if (!asset) return value; // unpublished asset — leave the stub
      return {
        id: asset.assetId,
        file: asset.file,
        title: asset.title,
        description: asset.description,
      };
    }
    return value;
  };

  const fields: Record<string, unknown> = {};
  for (const [apiId, localized] of Object.entries(snapshot.fields)) {
    if (opts.locale) {
      const resolved = resolveLocalizedValue(localized, localeCfg, opts.locale);
      if (resolved !== undefined) fields[apiId] = await resolveValue(resolved);
    } else {
      const perLocale: Record<string, unknown> = {};
      for (const [loc, v] of Object.entries(localized)) perLocale[loc] = await resolveValue(v);
      fields[apiId] = perLocale;
    }
  }

  return {
    id: snapshot.entryId,
    contentType: snapshot.contentTypeApiId,
    fields,
    publishedAt: snapshot.publishedAt,
    ...(snapshot.metadata
      ? { metadata: { tags: snapshot.metadata.tags, concepts: snapshot.metadata.concepts } }
      : {}),
  };
}

const clampDepth = (n: number | undefined) => Math.min(Math.max(0, n ?? 0), MAX_INCLUDE);

/**
 * Read path for the Delivery API. Reads only denormalized published snapshots
 * (never version history), then renders them with locale + reference resolution.
 */
export async function getPublishedEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  opts: RenderOptions = {},
): Promise<DeliveredEntry> {
  const depth = clampDepth(opts.include);
  const key = `cw:del:${scope.spaceId}:${scope.environmentId}:${id}:l=${opts.locale ?? ''}:i=${depth}`;

  if (ctx.cache) {
    const hit = await ctx.cache.get(key);
    if (hit) return JSON.parse(hit) as DeliveredEntry;
  }

  const snapshot = await ctx.store.entries.getPublished(scope, id);
  if (!snapshot) throw new NotFoundError('PublishedEntry', id);
  const config = await spaceConfig(ctx, scope);
  const collected = new Set<string>();
  const result = await render(ctx, scope, snapshot, config, opts, depth, new Set([id]), collected);

  if (ctx.cache) {
    // Tag the cached render with every entry it contains (root + embedded), so a
    // change to any of them evicts this render — even at include depth > 1.
    const tags = [...collected].map((eid) => cacheTag(scope, eid));
    await ctx.cache.set(key, JSON.stringify(result), { tags });
  }
  return result;
}

export async function listPublishedEntries(
  ctx: AppContext,
  scope: Scope,
  query: EntryQuery = {},
  opts: RenderOptions = {},
): Promise<DeliveredEntry[]> {
  const config = await spaceConfig(ctx, scope);
  // Filtering/ordering/search compare against a single resolved locale; default
  // to the requested locale, then the space default.
  const locale = query.locale ?? opts.locale ?? config.defaultLocale;
  const rows = await ctx.store.entries.listPublished(scope, { ...query, locale });
  const depth = clampDepth(opts.include);
  return Promise.all(
    rows.map((s) => render(ctx, scope, s, config, opts, depth, new Set([s.entryId]), new Set())),
  );
}

/** Entries that link to `id` — the reverse-reference graph (for invalidation). */
export async function getReverseReferences(ctx: AppContext, scope: Scope, id: string) {
  return ctx.store.references.findReverse(scope, id);
}

/** Shape test for an entry `render` embedded in place of a link stub. */
function isEmbeddedEntry(value: unknown): value is DeliveredEntry {
  const e = value as Partial<DeliveredEntry> | null;
  return (
    typeof e === 'object' &&
    e !== null &&
    !Array.isArray(e) &&
    typeof e.id === 'string' &&
    typeof e.contentType === 'string' &&
    typeof e.publishedAt === 'string' &&
    typeof e.fields === 'object' &&
    e.fields !== null
  );
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Shape test for an asset `render` embedded in place of an asset link
 * (`{ id, file, title?, description? }` — no contentType/publishedAt).
 */
function isEmbeddedAsset(value: unknown): value is { id: string } {
  const a = value as { id?: unknown; file?: unknown; contentType?: unknown };
  return (
    typeof a?.id === 'string' &&
    typeof a.file === 'object' &&
    a.file !== null &&
    a.contentType === undefined
  );
}

/**
 * Field-level RBAC over a RENDERED entry, embedded links included: masks the
 * root's denied fields, then walks every place `render` can put an embedded
 * entry (field values, array elements, per-locale maps) and masks each embed
 * by ITS content type — or reverts it to the unresolved `{ id, linkType }`
 * stub when the principal holds no read grant on that type. Must run
 * post-cache: the delivery cache is shared across principals, so a masked
 * render may never be written back.
 *
 * Detection is structural, so a user-authored JSON value shaped exactly like
 * an embedded entry is treated as one — masked or stubbed, never leaked
 * (conservative in the safe direction). No-grants principals pass through
 * untouched.
 */
export function maskDeliveredFields(
  principal: Principal,
  contentType: string,
  fields: Record<string, unknown>,
): Record<string, unknown> {
  if (!principal.contentGrants) return fields;
  // atLocaleMapLevel: embeds sit one plain-object level down when fields are
  // NOT locale-flattened ({ 'en-US': <embed> }); user JSON deeper than that
  // can never contain a render-produced embed, so the walk stops there.
  const walk = (value: unknown, atLocaleMapLevel: boolean): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, atLocaleMapLevel));
    if (isEmbeddedEntry(value)) {
      if (!canAccessContentType(principal, 'read', value.contentType)) {
        return { id: value.id, linkType: 'Entry' };
      }
      return {
        ...value,
        fields: maskDeliveredFields(principal, value.contentType, value.fields),
      };
    }
    // Granular principals get NO asset access on the delivery surface (the
    // asset endpoints 403 / return null for them) — embedded assets revert
    // to the unresolved link stub for the same policy.
    if (isEmbeddedAsset(value)) {
      return { id: value.id, linkType: 'Asset' };
    }
    if (atLocaleMapLevel && isPlainObject(value)) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, false)]));
    }
    return value;
  };
  const masked = maskDeniedFields(principal, contentType, fields);
  return Object.fromEntries(Object.entries(masked).map(([k, v]) => [k, walk(v, true)]));
}

import {
  type Entry,
  type EntryFields,
  type EntryVersion,
  NotFoundError,
  type Scope,
  type ValidationContext,
  assertEntryFieldsValid,
  deriveStatus,
  saveDraft,
} from '@cw/domain';
import type { ContentType } from '@cw/domain';
import type { AppContext } from './context.js';

/** Loads the validation context (locales) for a scope. */
async function loadValidationContext(ctx: AppContext, scope: Scope): Promise<ValidationContext> {
  const config = await ctx.store.spaces.getConfig(scope);
  if (!config) throw new NotFoundError('Space', scope.spaceId);
  return { defaultLocale: config.defaultLocale, locales: config.locales };
}

async function requireContentType(
  ctx: AppContext,
  scope: Scope,
  apiId: string,
): Promise<ContentType> {
  const ct = await ctx.store.contentTypes.get(scope, apiId);
  if (!ct) throw new NotFoundError('ContentType', apiId);
  return ct;
}

export interface CreateEntryInput {
  readonly contentTypeApiId: string;
  readonly fields: EntryFields;
}

export interface EntryView {
  readonly entry: Entry;
  readonly fields: EntryFields;
}

/** Creates a draft entry after validating its fields against the content type. */
export async function createEntry(
  ctx: AppContext,
  scope: Scope,
  input: CreateEntryInput,
): Promise<EntryView> {
  const contentType = await requireContentType(ctx, scope, input.contentTypeApiId);
  const vctx = await loadValidationContext(ctx, scope);
  assertEntryFieldsValid(contentType, input.fields, vctx);

  const id = ctx.ids.newId();
  const entry: Entry = {
    id,
    contentTypeApiId: input.contentTypeApiId,
    status: 'draft',
    currentVersion: 1,
    publishedVersion: null,
  };
  const version: EntryVersion = {
    entryId: id,
    version: 1,
    fields: input.fields,
    createdAt: ctx.clock.now().toISOString(),
  };
  await ctx.store.entries.create(scope, entry, version);
  return { entry, fields: input.fields };
}

export async function getEntry(ctx: AppContext, scope: Scope, id: string): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  return { entry: found.entry, fields: found.fields };
}

/** Saves an edited set of field values as a new draft version. */
export async function updateEntry(
  ctx: AppContext,
  scope: Scope,
  id: string,
  fields: EntryFields,
): Promise<EntryView> {
  const found = await ctx.store.entries.get(scope, id);
  if (!found) throw new NotFoundError('Entry', id);
  const contentType = await requireContentType(ctx, scope, found.entry.contentTypeApiId);
  const vctx = await loadValidationContext(ctx, scope);
  assertEntryFieldsValid(contentType, fields, vctx);

  const { entry, version } = saveDraft(found.entry, fields);
  // Keep status consistent with the published pointer.
  const synced: Entry = {
    ...entry,
    status: deriveStatus(entry.currentVersion, entry.publishedVersion, false),
  };
  const stamped: EntryVersion = { ...version, createdAt: ctx.clock.now().toISOString() };
  await ctx.store.entries.saveVersion(scope, synced, stamped);
  return { entry: synced, fields };
}

import {
  type Asset,
  type LocalizedValue,
  NotFoundError,
  type Scope,
  publishAsset as publishAssetState,
  unpublishAsset as unpublishAssetState,
} from '@cw/domain';
import type { BlobStore, PublishedAsset } from '@cw/ports';
import type { AppContext } from './context.js';

export interface CreateAssetInput {
  readonly fileName: string;
  readonly contentType: string;
  readonly title?: LocalizedValue;
  readonly description?: LocalizedValue;
}

export interface CreatedAsset {
  readonly asset: Asset;
  /** Presigned upload target — the client PUTs the bytes here directly. */
  readonly upload: { url: string; headers: Record<string, string> };
}

/**
 * Creates a draft asset and returns a presigned upload URL. The client uploads
 * the bytes straight to blob storage (they never transit the API), then
 * publishes the asset to make it deliverable.
 */
export async function createAsset(
  ctx: AppContext,
  blob: BlobStore,
  scope: Scope,
  input: CreateAssetInput,
): Promise<CreatedAsset> {
  const id = ctx.ids.newId();
  const key = `${scope.spaceId}/${scope.environmentId}/${id}/${input.fileName}`;
  const upload = await blob.getUploadUrl(key, input.contentType);
  const url = await blob.getDownloadUrl(key);
  const asset: Asset = {
    id,
    status: 'draft',
    file: { url, fileName: input.fileName, contentType: input.contentType },
    title: input.title ?? {},
    description: input.description ?? {},
  };
  await ctx.store.assets.create(scope, asset);
  return { asset, upload };
}

export async function getAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  return asset;
}

/** Publishes an asset — writes the denormalized snapshot served by Delivery. */
export async function publishAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const published = publishAssetState(asset);
  await ctx.store.assets.save(scope, published);
  await ctx.store.assets.putPublished(scope, {
    assetId: published.id,
    file: published.file,
    title: published.title,
    description: published.description,
    publishedAt: ctx.clock.now().toISOString(),
  });
  return published;
}

export async function unpublishAsset(ctx: AppContext, scope: Scope, id: string): Promise<Asset> {
  const asset = await ctx.store.assets.get(scope, id);
  if (!asset) throw new NotFoundError('Asset', id);
  const updated = unpublishAssetState(asset);
  await ctx.store.assets.save(scope, updated);
  await ctx.store.assets.removePublished(scope, id);
  return updated;
}

export async function getPublishedAsset(
  ctx: AppContext,
  scope: Scope,
  id: string,
): Promise<PublishedAsset> {
  const snapshot = await ctx.store.assets.getPublished(scope, id);
  if (!snapshot) throw new NotFoundError('PublishedAsset', id);
  return snapshot;
}

export async function listPublishedAssets(
  ctx: AppContext,
  scope: Scope,
  query: { limit?: number; skip?: number } = {},
): Promise<PublishedAsset[]> {
  return ctx.store.assets.listPublished(scope, query);
}

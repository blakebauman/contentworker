import { InvalidStateError } from '../errors.js';
import type { LocalizedValue } from '../types.js';

/** Metadata describing the stored binary (the bytes live in the BlobStore). */
export interface AssetFile {
  /** Download URL (presigned or public). */
  readonly url: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly size?: number;
  readonly width?: number;
  readonly height?: number;
}

export type AssetStatus = 'draft' | 'published' | 'archived';

/**
 * An asset: a managed binary (image, document, …) with localized title and
 * description. Simpler than entries — single current revision, no version
 * history — which is sufficient for media metadata.
 */
export interface Asset {
  readonly id: string;
  readonly status: AssetStatus;
  readonly file: AssetFile;
  readonly title: LocalizedValue;
  readonly description: LocalizedValue;
}

export function publishAsset(asset: Asset): Asset {
  if (asset.status === 'archived') throw new InvalidStateError('Cannot publish an archived asset');
  return { ...asset, status: 'published' };
}

export function unpublishAsset(asset: Asset): Asset {
  if (asset.status !== 'published') throw new InvalidStateError('Asset is not published');
  return { ...asset, status: 'draft' };
}

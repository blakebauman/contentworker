import { InvalidStateError, ValidationError } from '../errors.js';
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
 * A relative focal point (0..1 on each axis) marking the visually important
 * region of an image, so transforms can crop toward it instead of the center.
 */
export interface FocalPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * Editorial media metadata ("Aspects"): localized alt text for accessibility,
 * a focal point for smart cropping, taxonomy tag ids, and free-form custom
 * fields. Distinct from {@link AssetFile}, which describes the stored bytes.
 */
export interface AssetMetadata {
  readonly altText: LocalizedValue;
  readonly tags: readonly string[];
  readonly focalPoint?: FocalPoint;
  readonly fields?: Readonly<Record<string, unknown>>;
}

/** The metadata a freshly-created asset carries before anyone edits it. */
export const emptyAssetMetadata: AssetMetadata = { altText: {}, tags: [] };

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
  readonly metadata: AssetMetadata;
}

/**
 * Merges a metadata patch onto an asset, validating the focal point stays
 * within the unit square. Only keys present (non-`undefined`) in the patch
 * override existing values, so a partial update never clears omitted fields.
 * Returns a new asset; the caller persists it.
 */
export function applyAssetMetadata(asset: Asset, patch: Partial<AssetMetadata>): Asset {
  const focalPoint = patch.focalPoint ?? asset.metadata.focalPoint;
  if (
    focalPoint &&
    (focalPoint.x < 0 || focalPoint.x > 1 || focalPoint.y < 0 || focalPoint.y > 1)
  ) {
    throw new ValidationError([
      { field: 'focalPoint', message: 'Focal point coordinates must be between 0 and 1' },
    ]);
  }
  const fields = patch.fields ?? asset.metadata.fields;
  return {
    ...asset,
    metadata: {
      altText: patch.altText ?? asset.metadata.altText,
      tags: patch.tags ?? asset.metadata.tags,
      ...(focalPoint ? { focalPoint } : {}),
      ...(fields ? { fields } : {}),
    },
  };
}

export function publishAsset(asset: Asset): Asset {
  if (asset.status === 'archived') throw new InvalidStateError('Cannot publish an archived asset');
  return { ...asset, status: 'published' };
}

export function unpublishAsset(asset: Asset): Asset {
  if (asset.status !== 'published') throw new InvalidStateError('Asset is not published');
  return { ...asset, status: 'draft' };
}

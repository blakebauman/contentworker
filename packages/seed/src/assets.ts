import { createAsset, listAssets, publishAsset, setAssetMetadata } from '@cw/application';
import type { BlobStore } from '@cw/ports';
import { logger } from '@cw/telemetry';
import { localized, pick } from './helpers.js';
import type { SeedRun } from './types.js';

const FILES = [
  { fileName: 'hero-coastline.jpg', contentType: 'image/jpeg', title: 'Coastline at dawn' },
  { fileName: 'team-offsite.png', contentType: 'image/png', title: 'Team offsite' },
  { fileName: 'product-shot-01.jpg', contentType: 'image/jpeg', title: 'Product shot 1' },
  { fileName: 'product-shot-02.jpg', contentType: 'image/jpeg', title: 'Product shot 2' },
  { fileName: 'architecture-diagram.png', contentType: 'image/png', title: 'Architecture diagram' },
  { fileName: 'launch-keynote.mp4', contentType: 'video/mp4', title: 'Launch keynote' },
  { fileName: 'whitepaper.pdf', contentType: 'application/pdf', title: 'Platform whitepaper' },
  { fileName: 'press-kit.pdf', contentType: 'application/pdf', title: 'Press kit' },
  { fileName: 'conference-stage.jpg', contentType: 'image/jpeg', title: 'Conference stage' },
  { fileName: 'recipe-plating.jpg', contentType: 'image/jpeg', title: 'Plated dish' },
] as const;

/**
 * Ten demo assets across image/video/pdf types. The bytes are never uploaded —
 * publishing only snapshots metadata, and dev runs on the fake blob store —
 * so create → metadata → publish is enough. The last two stay drafts so the
 * media library shows both statuses. Returns published asset ids for links.
 */
export async function seedAssets(run: SeedRun, blob: BlobStore): Promise<string[]> {
  const { ctx, scope, locale } = run;

  const existing = await listAssets(ctx, scope, { limit: FILES.length + 10 });
  if (existing.length > 0) {
    return existing.filter((a) => a.status === 'published').map((a) => a.id);
  }

  const publishedIds: string[] = [];
  for (const [i, file] of FILES.entries()) {
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: file.fileName,
      contentType: file.contentType,
      title: localized(locale, file.title) as Record<string, string>,
    });
    if (i % 2 === 0) {
      await setAssetMetadata(ctx, scope, asset.id, {
        altText: localized(locale, `${file.title} (alt text)`) as Record<string, string>,
        tags: [pick(['brand', 'press', 'product'] as const, i)],
        focalPoint: { x: 0.25 + (i % 3) * 0.25, y: 0.5 },
      });
    }
    const publish = i < FILES.length - 2;
    if (publish) {
      await publishAsset(ctx, scope, asset.id);
      publishedIds.push(asset.id);
    }
  }
  logger.info({ assets: FILES.length }, 'seed: created assets');
  return publishedIds;
}

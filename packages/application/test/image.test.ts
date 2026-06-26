import { ValidationError } from '@cw/domain';
import { FakeBlobStore, FixedClock, InMemoryContentStore, SequenceIdGenerator } from '@cw/test-kit';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppContext,
  buildImageUrl,
  createAsset,
  createSpace,
  parseImageTransform,
  publishAsset,
  setAssetMetadata,
  transformAssetUrl,
  transformPublishedAssetUrl,
} from '../src/index.js';

const scope = { spaceId: 'shop', environmentId: 'main' };

function setup() {
  const store = new InMemoryContentStore();
  const blob = new FakeBlobStore();
  const ctx: AppContext = { store, clock: new FixedClock(), ids: new SequenceIdGenerator('a') };
  return { ctx, blob };
}

describe('buildImageUrl', () => {
  it('appends imgix-style params', () => {
    const url = new URL(
      buildImageUrl('https://cdn.example/img.png', {
        width: 400,
        height: 300,
        fit: 'fill',
        format: 'webp',
        quality: 80,
      }),
    );
    expect(url.searchParams.get('w')).toBe('400');
    expect(url.searchParams.get('h')).toBe('300');
    expect(url.searchParams.get('fit')).toBe('fill');
    expect(url.searchParams.get('fm')).toBe('webp');
    expect(url.searchParams.get('q')).toBe('80');
  });

  it('anchors crop to the focal point only when fit=crop', () => {
    const fp = { x: 0.25, y: 0.75 };
    const cropped = new URL(buildImageUrl('https://cdn/i', { fit: 'crop', width: 100 }, fp));
    expect(cropped.searchParams.get('crop')).toBe('focalpoint');
    expect(cropped.searchParams.get('fp-x')).toBe('0.25');
    expect(cropped.searchParams.get('fp-y')).toBe('0.75');

    const filled = new URL(buildImageUrl('https://cdn/i', { fit: 'fill', width: 100 }, fp));
    expect(filled.searchParams.has('crop')).toBe(false);
  });
});

describe('parseImageTransform', () => {
  it('reads w/h/fit/fm/q and ignores blanks', () => {
    expect(parseImageTransform({ w: '200', fit: 'crop', q: '90' })).toEqual({
      width: 200,
      height: undefined,
      fit: 'crop',
      format: undefined,
      quality: 90,
    });
  });
});

describe('transformAssetUrl', () => {
  let ctx: AppContext;
  let blob: FakeBlobStore;
  beforeEach(() => {
    ({ ctx, blob } = setup());
    return createSpace(ctx, { spaceId: 'shop', name: 'Shop', defaultLocale: 'en-US' });
  });

  async function newImage() {
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'photo.jpg',
      contentType: 'image/jpeg',
    });
    return asset.id;
  }

  it('uses the asset focal point when cropping', async () => {
    const id = await newImage();
    await setAssetMetadata(ctx, scope, id, { focalPoint: { x: 0.1, y: 0.2 } });
    const { url } = await transformAssetUrl(ctx, scope, id, { fit: 'crop', width: 50 });
    const params = new URL(url).searchParams;
    expect(params.get('fp-x')).toBe('0.1');
    expect(params.get('fp-y')).toBe('0.2');
  });

  it('rejects a non-image asset', async () => {
    const { asset } = await createAsset(ctx, blob, scope, {
      fileName: 'doc.pdf',
      contentType: 'application/pdf',
    });
    await expect(transformAssetUrl(ctx, scope, asset.id, { width: 10 })).rejects.toThrow(
      ValidationError,
    );
  });

  it('rejects an out-of-range quality', async () => {
    const id = await newImage();
    await expect(transformAssetUrl(ctx, scope, id, { quality: 0 })).rejects.toThrow(
      ValidationError,
    );
  });

  it('transforms the published snapshot on the delivery surface', async () => {
    const id = await newImage();
    await publishAsset(ctx, scope, id);
    const { url } = await transformPublishedAssetUrl(ctx, scope, id, {
      width: 120,
      format: 'avif',
    });
    const params = new URL(url).searchParams;
    expect(params.get('w')).toBe('120');
    expect(params.get('fm')).toBe('avif');
  });
});

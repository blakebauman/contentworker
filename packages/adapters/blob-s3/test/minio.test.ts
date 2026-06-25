import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { createS3BlobStore } from '../src/index.js';

// Gated on MINIO_ENDPOINT so the normal suite (no MinIO) skips it.
const endpoint = process.env.MINIO_ENDPOINT;

// The adapter resolves credentials from the default AWS chain → set MinIO creds.
process.env.AWS_ACCESS_KEY_ID ??= 'minioadmin';
process.env.AWS_SECRET_ACCESS_KEY ??= 'minioadmin';

describe.skipIf(!endpoint)('S3 BlobStore against a real MinIO', () => {
  it('presigned PUT upload → presigned GET download round-trips, then deletes', async () => {
    const bucket = 'cw-assets';
    const common = {
      region: 'us-east-1',
      endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'minioadmin', secretAccessKey: 'minioadmin' },
    } as const;

    // Ensure the bucket exists.
    const admin = new S3Client(common);
    try {
      await admin.send(new CreateBucketCommand({ Bucket: bucket }));
    } catch {
      /* already exists */
    }

    const blob = createS3BlobStore({ bucket, endpoint, forcePathStyle: true, region: 'us-east-1' });
    const key = 'space-1/main/asset-1/hello.txt';
    const body = 'hello from contentworker';

    // 1. Presigned upload — bytes go straight to storage.
    const upload = await blob.getUploadUrl(key, 'text/plain');
    const put = await fetch(upload.url, { method: 'PUT', headers: upload.headers, body });
    expect(put.ok).toBe(true);

    // 2. Presigned download — read the bytes back.
    const downloadUrl = await blob.getDownloadUrl(key);
    const got = await fetch(downloadUrl);
    expect(got.ok).toBe(true);
    expect(await got.text()).toBe(body);

    // 3. Delete — subsequent download 404s.
    await blob.delete(key);
    const after = await fetch(await blob.getDownloadUrl(key));
    expect(after.status).toBe(404);
  }, 30_000);
});

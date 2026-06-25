import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { BlobStore } from '@cw/ports';

export interface S3BlobOptions {
  readonly bucket: string;
  readonly region?: string;
  /** Custom endpoint for S3-compatible stores (MinIO, R2, GCS interop). */
  readonly endpoint?: string;
  /** Path-style addressing — required by MinIO and most S3-compatibles. */
  readonly forcePathStyle?: boolean;
  /** Presigned URL lifetime in seconds (default 900). */
  readonly expiresIn?: number;
  /** Public base URL for downloads; when set, download URLs are unsigned. */
  readonly publicBaseUrl?: string;
}

/**
 * S3-compatible BlobStore. Works against AWS S3, MinIO, Cloudflare R2, and GCS
 * (interop) via the `endpoint` / `forcePathStyle` options — the cloud-agnostic
 * blob adapter. Uploads use presigned PUT URLs so bytes never transit the API.
 */
export function createS3BlobStore(opts: S3BlobOptions): BlobStore {
  const client = new S3Client({
    region: opts.region ?? process.env.AWS_REGION ?? 'us-east-1',
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.forcePathStyle ? { forcePathStyle: true } : {}),
  });
  const expiresIn = opts.expiresIn ?? 900;

  return {
    async getUploadUrl(key, contentType) {
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: opts.bucket, Key: key, ContentType: contentType }),
        { expiresIn },
      );
      return { url, headers: { 'content-type': contentType } };
    },
    async getDownloadUrl(key) {
      if (opts.publicBaseUrl) return `${opts.publicBaseUrl.replace(/\/$/, '')}/${key}`;
      return getSignedUrl(client, new GetObjectCommand({ Bucket: opts.bucket, Key: key }), {
        expiresIn,
      });
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: opts.bucket, Key: key }));
    },
  };
}

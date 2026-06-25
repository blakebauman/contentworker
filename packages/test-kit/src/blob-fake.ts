import type { BlobStore } from '@cw/ports';

/**
 * An in-memory BlobStore for dev/tests. It hands out deterministic fake
 * presigned URLs and records uploads/deletes — no bytes are stored. Mirrors the
 * S3 adapter's contract (presigned PUT for upload, URL for download).
 */
export class FakeBlobStore implements BlobStore {
  readonly uploads: { key: string; contentType: string }[] = [];
  readonly deletes: string[] = [];
  constructor(private readonly base = 'https://blob.local') {}

  async getUploadUrl(key: string, contentType: string) {
    this.uploads.push({ key, contentType });
    return { url: `${this.base}/${key}?upload=1`, headers: { 'content-type': contentType } };
  }
  async getDownloadUrl(key: string) {
    return `${this.base}/${key}`;
  }
  async delete(key: string) {
    this.deletes.push(key);
  }
}

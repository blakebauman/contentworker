import type { Asset } from '@cw/domain';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ManagementClient } from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/** Media library: lists assets, uploads via presigned PUT, publishes. */
export function MediaLibrary(props: { client: ManagementClient; locale: string }) {
  const { client, locale } = props;
  const toast = useToast();
  const [assets, setAssets] = useState<Asset[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setAssets(await client.listAssets());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      await client.uploadAsset(file); // create → presigned PUT → publish
      await load();
      toast.success(`Uploaded ${file.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <>
      <div className="row between">
        <h1 className="h">Media</h1>
        <div>
          <input
            ref={fileRef}
            type="file"
            style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
          <button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Uploading…' : '+ Upload asset'}
          </button>
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))',
          gap: 12,
        }}
      >
        {assets.map((a) => (
          <div
            key={a.id}
            style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8 }}
          >
            {a.file.contentType.startsWith('image/') ? (
              <img
                src={a.file.url}
                alt={a.file.fileName}
                style={{ width: '100%', height: 110, objectFit: 'cover', borderRadius: 4 }}
              />
            ) : (
              <div className="muted" style={{ height: 110, display: 'grid', placeItems: 'center' }}>
                {a.file.contentType}
              </div>
            )}
            <div
              style={{
                marginTop: 6,
                fontSize: 13,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {String(a.title?.[locale] ?? a.file.fileName)}
            </div>
            <div className="row between" style={{ marginTop: 4 }}>
              <span className={`badge ${a.status}`}>{a.status}</span>
              {a.status !== 'published' && (
                <button
                  type="button"
                  className="ghost"
                  onClick={() => client.publishAsset(a.id).then(load)}
                >
                  Publish
                </button>
              )}
            </div>
          </div>
        ))}
        {assets.length === 0 && <p className="muted">No assets yet. Upload one to get started.</p>}
      </div>
    </>
  );
}

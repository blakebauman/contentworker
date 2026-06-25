import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Media</h1>
        <div>
          <input
            ref={fileRef}
            type="file"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
          />
          <Button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            {busy ? 'Uploading…' : '+ Upload asset'}
          </Button>
        </div>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
        {assets.map((a) => (
          <Card key={a.id} size="sm" className="gap-2 p-2">
            {a.file.contentType.startsWith('image/') ? (
              <img
                src={a.file.url}
                alt={a.file.fileName}
                className="h-28 w-full rounded-md object-cover"
              />
            ) : (
              <div className="grid h-28 place-items-center rounded-md bg-muted text-xs text-muted-foreground">
                {a.file.contentType}
              </div>
            )}
            <div className="truncate text-sm">{String(a.title?.[locale] ?? a.file.fileName)}</div>
            <div className="flex items-center justify-between">
              <StatusBadge status={a.status} />
              {a.status !== 'published' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => client.publishAsset(a.id).then(load)}
                >
                  Publish
                </Button>
              )}
            </div>
          </Card>
        ))}
        {assets.length === 0 && (
          <p className="text-muted-foreground">No assets yet. Upload one to get started.</p>
        )}
      </div>
    </div>
  );
}

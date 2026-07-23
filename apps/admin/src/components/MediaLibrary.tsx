import { AssetDetailSheet } from '@/components/AssetDetailSheet';
import { EmptyState } from '@/components/EmptyState';
import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Asset } from '@cw/domain';
import { ImageIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import { useAssetsQuery, useInvalidate } from '../lib/queries.js';
import { useToast } from '../lib/toast.js';

/** Media library: lists assets, uploads via presigned PUT, publishes. */
export function MediaLibrary(props: { locale: string }) {
  const { locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<Asset | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const assets = useAssetsQuery().data ?? [];
  const reload = () => invalidate(['assets']);

  const onUpload = async (file: File) => {
    setBusy(true);
    try {
      await client.uploadAsset(file); // create → presigned PUT → publish
      await reload();
      toast.success(`Uploaded ${file.name}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const setPublished = (id: string, publish: boolean) =>
    void (publish ? client.publishAsset(id) : client.unpublishAsset(id))
      .then(reload)
      .catch((e) => toast.error(e instanceof Error ? e.message : String(e)));

  return (
    <div className="space-y-4">
      <PageHeader title="Media" description="Images and files you can reference from entries.">
        <input
          ref={fileRef}
          type="file"
          className="hidden"
          onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])}
        />
        <Button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
          {busy ? 'Uploading…' : '+ Upload asset'}
        </Button>
      </PageHeader>
      {assets.length === 0 ? (
        <EmptyState
          icon={ImageIcon}
          title="No assets yet"
          description="Upload an image or file to start building your media library."
        >
          <Button type="button" disabled={busy} onClick={() => fileRef.current?.click()}>
            Upload asset
          </Button>
        </EmptyState>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
          {assets.map((a) => (
            <Card
              key={a.id}
              size="sm"
              className="cursor-pointer gap-2 p-2 transition-colors hover:border-primary/50"
              onClick={() => setSelected(a)}
            >
              {a.file.contentType.startsWith('image/') ? (
                <img
                  src={a.file.url}
                  alt={String(a.metadata.altText?.[locale] ?? a.file.fileName)}
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
                {a.status === 'published' ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPublished(a.id, false);
                    }}
                  >
                    Unpublish
                  </Button>
                ) : (
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPublished(a.id, true);
                    }}
                  >
                    Publish
                  </Button>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
      <AssetDetailSheet
        asset={selected}
        locale={locale}
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        onSaved={() => void reload()}
      />
    </div>
  );
}

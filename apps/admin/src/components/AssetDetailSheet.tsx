import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import type { Asset, ReferenceEdge, Tag } from '@cw/domain';
import { useEffect, useRef, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import { useToast } from '../lib/toast.js';

/**
 * Edits an asset's media "Aspects": localized alt text, a click-to-set focal
 * point for smart cropping, taxonomy tags, and the list of entries using it.
 * Saving patches metadata; the caller refreshes the library on close.
 */
export function AssetDetailSheet(props: {
  asset: Asset | null;
  locale: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { asset, locale } = props;
  const { client } = useClient();
  const toast = useToast();
  const [altText, setAltText] = useState('');
  const [focal, setFocal] = useState<{ x: number; y: number } | undefined>();
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [allTags, setAllTags] = useState<Tag[]>([]);
  const [usage, setUsage] = useState<ReferenceEdge[] | null>(null);
  const [busy, setBusy] = useState(false);
  const imgRef = useRef<HTMLButtonElement>(null);

  // Hydrate form state from the asset whenever the sheet opens on a new asset.
  useEffect(() => {
    if (!asset || !props.open) return;
    setAltText(String(asset.metadata.altText?.[locale] ?? ''));
    setFocal(asset.metadata.focalPoint);
    setTagIds([...asset.metadata.tags]);
    setUsage(null);
    client
      .listTags()
      .then(setAllTags)
      .catch(() => setAllTags([]));
    client
      .assetUsage(asset.id)
      .then(setUsage)
      .catch(() => setUsage([]));
  }, [asset, props.open, locale, client]);

  if (!asset) return null;
  const isImage = asset.file.contentType.startsWith('image/');

  const pickFocal = (e: React.MouseEvent<HTMLButtonElement>) => {
    const rect = imgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    setFocal({ x: Number(x.toFixed(3)), y: Number(y.toFixed(3)) });
  };

  const toggleTag = (id: string) => {
    setTagIds((ids) => (ids.includes(id) ? ids.filter((t) => t !== id) : [...ids, id]));
  };

  const save = async () => {
    setBusy(true);
    try {
      await client.setAssetMetadata(asset.id, {
        altText: { ...asset.metadata.altText, [locale]: altText },
        tags: tagIds,
        focalPoint: focal,
      });
      toast.success('Metadata saved');
      props.onSaved();
      props.onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="truncate">{asset.file.fileName}</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {asset.file.contentType}
          </SheetDescription>
        </SheetHeader>

        <div className="space-y-5 px-4 pb-4">
          {isImage && (
            <div className="space-y-1.5">
              <Label>Focal point</Label>
              <button
                type="button"
                ref={imgRef}
                onClick={pickFocal}
                className="relative block w-full cursor-crosshair overflow-hidden rounded-md border"
              >
                <img src={asset.file.url} alt={altText || asset.file.fileName} className="w-full" />
                {focal && (
                  <span
                    className="-translate-x-1/2 -translate-y-1/2 pointer-events-none absolute size-5 rounded-full border-2 border-white bg-primary/60 shadow"
                    style={{ left: `${focal.x * 100}%`, top: `${focal.y * 100}%` }}
                  />
                )}
              </button>
              <p className="text-muted-foreground text-xs">
                {focal
                  ? `x ${focal.x}, y ${focal.y} — click to move`
                  : 'Click the image to set a focal point for smart cropping.'}
              </p>
            </div>
          )}

          <div className="space-y-1.5">
            <Label htmlFor="asset-alt">Alt text ({locale})</Label>
            <Textarea
              id="asset-alt"
              value={altText}
              onChange={(e) => setAltText(e.target.value)}
              placeholder="Describe the image for accessibility and SEO."
              rows={3}
            />
          </div>

          <div className="space-y-1.5">
            <Label>Tags</Label>
            {allTags.length === 0 ? (
              <p className="text-muted-foreground text-sm">No tags defined in this space yet.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {allTags.map((t) => (
                  <button key={t.id} type="button" onClick={() => toggleTag(t.id)}>
                    <Badge variant={tagIds.includes(t.id) ? 'default' : 'outline'}>{t.name}</Badge>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1.5">
            <Label>Used by {usage ? `(${usage.length})` : ''}</Label>
            {usage === null ? (
              <p className="text-muted-foreground text-sm">Loading…</p>
            ) : usage.length === 0 ? (
              <p className="text-muted-foreground text-sm">Not referenced by any entry.</p>
            ) : (
              <ul className="space-y-1">
                {usage.map((u) => (
                  <li key={`${u.fromEntryId}:${u.fromField}`} className="font-mono text-xs">
                    {u.fromEntryId}
                    <span className="text-muted-foreground"> · {u.fromField}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <SheetFooter>
          <Button type="button" onClick={save} disabled={busy}>
            {busy ? 'Saving…' : 'Save metadata'}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

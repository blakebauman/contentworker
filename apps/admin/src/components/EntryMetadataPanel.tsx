import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { Concept, Tag } from '@cw/domain';
import { Link as LinkIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';
import { useToast } from '../lib/toast.js';

/** A toggleable chip; selected chips render filled. */
function Chip(props: {
  label: string;
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
}) {
  return (
    <button type="button" onClick={props.onToggle} disabled={props.disabled}>
      <Badge
        variant={props.selected ? 'default' : 'outline'}
        className={cn('cursor-pointer', !props.selected && 'hover:bg-muted')}
      >
        {props.label}
      </Badge>
    </button>
  );
}

/**
 * Associates an entry with taxonomy tags and concepts. The selection takes
 * effect on the next publish (the published snapshot copies the metadata), so a
 * note nudges the editor to publish. P14 entry tagging.
 */
export function EntryMetadataPanel(props: { entryId: string }) {
  const { client, busy, run } = useClient();
  const toast = useToast();
  const [tags, setTags] = useState<Tag[]>([]);
  const [concepts, setConcepts] = useState<Concept[]>([]);
  const [selTags, setSelTags] = useState<Set<string>>(new Set());
  const [selConcepts, setSelConcepts] = useState<Set<string>>(new Set());

  const load = useCallback(
    () =>
      run(async () => {
        const [allTags, allConcepts, meta] = await Promise.all([
          client.listTags(),
          client.listConcepts(),
          client.getEntryMetadata(props.entryId),
        ]);
        setTags(allTags);
        setConcepts(allConcepts);
        setSelTags(new Set(meta.tags));
        setSelConcepts(new Set(meta.concepts));
      }),
    [client, run, props.entryId],
  );
  useEffect(() => {
    load();
  }, [load]);

  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const save = () =>
    run(async () => {
      await client.setEntryMetadata(props.entryId, {
        tags: [...selTags],
        concepts: [...selConcepts],
      });
      toast.success('Tags & concepts saved');
    });

  const empty = tags.length === 0 && concepts.length === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags & concepts</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {empty ? (
          <p className="text-muted-foreground text-sm">
            No vocabulary defined yet. Add tags and concepts under{' '}
            <Link to="/taxonomy" className="inline-flex items-center gap-1 underline">
              <LinkIcon className="size-3" />
              Taxonomy
            </Link>
            .
          </p>
        ) : (
          <>
            {tags.length > 0 && (
              <div className="space-y-2">
                <p className="font-medium text-sm">Tags</p>
                <div className="flex flex-wrap gap-2">
                  {tags.map((t) => (
                    <Chip
                      key={t.id}
                      label={t.name}
                      selected={selTags.has(t.id)}
                      onToggle={() => toggle(selTags, setSelTags, t.id)}
                      disabled={busy}
                    />
                  ))}
                </div>
              </div>
            )}
            {concepts.length > 0 && (
              <div className="space-y-2">
                <p className="font-medium text-sm">Concepts</p>
                <div className="flex flex-wrap gap-2">
                  {concepts.map((c) => (
                    <Chip
                      key={c.id}
                      label={c.prefLabel}
                      selected={selConcepts.has(c.id)}
                      onToggle={() => toggle(selConcepts, setSelConcepts, c.id)}
                      disabled={busy}
                    />
                  ))}
                </div>
              </div>
            )}
            <div className="flex items-center justify-between gap-2 border-t pt-3">
              <p className="text-muted-foreground text-xs">Applies on the next publish.</p>
              <Button type="button" size="sm" onClick={save} disabled={busy}>
                Save
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

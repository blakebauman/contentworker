import { ContentTypeDialog } from '@/components/ContentTypeDialog';
import { StatusBadge } from '@/components/StatusBadge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import type { ContentType, ContentTypeDraft } from '@cw/domain';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';
import { useToast } from '../lib/toast.js';
import { useContentOutlet } from './content-context.js';

/** Content-types overview: a card per type with create / edit / publish, the
 * marquee surface for managing the space's schema from the UI. */
export function ContentTypesOverview() {
  const { client, run } = useClient();
  const { types, reload } = useContentOutlet();
  const toast = useToast();
  const [dialog, setDialog] = useState<{ open: boolean; initial?: ContentType }>({ open: false });

  const save = (draft: ContentTypeDraft) =>
    run(async () => {
      await client.saveContentType(draft);
      await client.publishContentType(draft.apiId);
      reload();
      toast.success(`Content type “${draft.name}” saved`);
    });

  const publish = (ct: ContentType) =>
    run(async () => {
      await client.publishContentType(ct.apiId);
      reload();
      toast.success(`Published “${ct.name}”`);
    });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {types.map((ct) => (
          <Card key={ct.apiId} className="justify-between">
            <CardHeader>
              <div className="flex items-center justify-between gap-2">
                <CardTitle>{ct.name}</CardTitle>
                <StatusBadge status={ct.status} />
              </div>
              <CardDescription className="font-mono text-xs">{ct.apiId}</CardDescription>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {ct.fields.length} {ct.fields.length === 1 ? 'field' : 'fields'} · display:{' '}
              <span className="font-mono">{ct.displayField}</span>
            </CardContent>
            <CardFooter className="gap-2">
              <Button asChild variant="outline" size="sm">
                <Link to={`/content/${ct.apiId}`}>View entries</Link>
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDialog({ open: true, initial: ct })}
              >
                Edit
              </Button>
              {ct.status === 'draft' && (
                <Button size="sm" onClick={() => publish(ct)}>
                  Publish
                </Button>
              )}
            </CardFooter>
          </Card>
        ))}

        {/* Create card */}
        <button
          type="button"
          onClick={() => setDialog({ open: true })}
          className="flex min-h-32 flex-col items-center justify-center gap-2 rounded-[min(var(--radius-4xl),24px)] border border-dashed text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
        >
          <Plus className="size-5" />
          <span className="text-sm font-medium">New content type</span>
        </button>
      </div>

      {/* Key on the target so the form seeds fresh each time it opens. */}
      <ContentTypeDialog
        key={`${dialog.open}:${dialog.initial?.apiId ?? 'new'}`}
        open={dialog.open}
        onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
        initial={dialog.initial}
        onSave={save}
      />
    </div>
  );
}

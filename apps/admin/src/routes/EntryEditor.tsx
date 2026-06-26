import { AiAssistPanel } from '@/components/AiAssistPanel';
import { CollaborationPanel } from '@/components/CollaborationPanel';
import { EntryMetadataPanel } from '@/components/EntryMetadataPanel';
import { PageHeader } from '@/components/PageHeader';
import { ReferencedBy } from '@/components/ReferencedBy';
import { VersionHistory } from '@/components/VersionHistory';
import { Button } from '@/components/ui/button';
import type { EntryFields } from '@cw/domain';
import { Sparkles } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Pickers } from '../components/EntryForm.js';
import { EntryForm } from '../components/EntryForm.js';
import { GenerateEntryDialog } from '../components/GenerateEntryDialog.js';
import { useClient } from '../lib/client-context.js';
import type { ModelTier } from '../lib/management.js';
import { useToast } from '../lib/toast.js';
import { useContentOutlet } from './content-context.js';

/** Create (/content/:typeId/new) or edit (/content/:typeId/:entryId) one entry. */
export function EntryEditor() {
  const { typeId, entryId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types, locales, defaultLocale } = useContentOutlet();

  const isEdit = Boolean(entryId);
  const selectedType = types.find((t) => t.apiId === typeId);
  const backTo = `/content/${typeId}`;

  const [initial, setInitial] = useState<EntryFields | null>(isEdit ? null : {});
  const [meta, setMeta] = useState<{ version: number; status: string } | null>(null);
  const [pickers, setPickers] = useState<Pickers>({ entries: [], assets: [] });
  const [genOpen, setGenOpen] = useState(false);
  // Bumped after a generation/restore to re-seed the form (EntryForm reads `initial` once).
  const [formKey, setFormKey] = useState(0);

  // Load the existing draft (edit mode) into the form's initial values.
  const loadEntry = useCallback(async () => {
    if (!isEdit || !entryId) return;
    const e = await client.getEntry(entryId);
    setInitial(e.fields as EntryFields);
    setMeta({ version: e.version, status: e.status });
  }, [client, entryId, isEdit]);

  useEffect(() => {
    let live = true;
    loadEntry().catch((err) => {
      if (!live) return;
      toast.error(err instanceof Error ? err.message : String(err));
      navigate(backTo);
    });
    return () => {
      live = false;
    };
  }, [loadEntry, navigate, backTo, toast]);

  // Build reference/asset picker options (all entries + all assets) for Link fields.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [allEntries, assets] = await Promise.all([client.listEntries(), client.listAssets()]);
        if (!live) return;
        const displayFieldOf = new Map(types.map((t) => [t.apiId, t.displayField]));
        setPickers({
          entries: allEntries.map((e) => {
            const df = displayFieldOf.get(e.contentType);
            const title = df
              ? (e.fields[df] as Record<string, unknown> | undefined)?.[conn.locale]
              : undefined;
            return {
              id: e.id,
              contentType: e.contentType,
              label: `${String(title ?? e.id)} (${e.contentType})`,
            };
          }),
          assets: assets.map((a) => ({
            id: a.id,
            label: String(a.title?.[conn.locale] ?? a.file.fileName),
          })),
        });
      } catch {
        /* pickers are best-effort; the form still works without them */
      }
    })();
    return () => {
      live = false;
    };
  }, [client, types, conn.locale]);

  const save = (fields: EntryFields) =>
    run(async () => {
      if (!selectedType) return;
      if (isEdit && entryId) await client.updateEntry(entryId, fields);
      else await client.createEntry(selectedType.apiId, fields);
      toast.success(isEdit ? 'Draft updated' : 'Entry created');
      navigate(backTo);
    });

  // Generate field values from a prompt and merge them into the form (throws on
  // error so the dialog can surface it; not wrapped in `run`).
  const generate = async (prompt: string, tier: ModelTier) => {
    if (!selectedType) return;
    const res = await client.generateEntry({ contentTypeApiId: selectedType.apiId, prompt, tier });
    setInitial((prev) => ({ ...(prev ?? {}), ...res.fields }));
    setFormKey((k) => k + 1);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Generated ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  };

  if (!selectedType) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title={`${isEdit ? 'Edit' : 'New'} ${selectedType.name}`}
        description={
          isEdit ? 'Update this entry’s draft fields.' : `Author a new ${selectedType.name} entry.`
        }
      >
        <Button type="button" variant="outline" onClick={() => setGenOpen(true)}>
          <Sparkles className="size-4" /> Generate with AI
        </Button>
      </PageHeader>
      {initial === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <EntryForm
          key={formKey}
          contentType={selectedType}
          initial={initial}
          locales={locales}
          defaultLocale={defaultLocale}
          pickers={pickers}
          busy={busy}
          onSave={save}
          onCancel={() => navigate(backTo)}
        />
      )}
      <GenerateEntryDialog
        open={genOpen}
        onOpenChange={setGenOpen}
        contentTypeName={selectedType.name}
        onGenerate={generate}
      />
      {isEdit && entryId && (
        <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
          <AiAssistPanel
            entryId={entryId}
            contentType={selectedType}
            locales={locales}
            defaultLocale={defaultLocale}
            onApplied={() => {
              loadEntry();
              setFormKey((k) => k + 1);
            }}
          />
          <CollaborationPanel entryId={entryId} />
          <EntryMetadataPanel entryId={entryId} />
          {meta && (
            <VersionHistory
              entryId={entryId}
              currentVersion={meta.version}
              publishedVersion={meta.status === 'published' ? meta.version : null}
              onRestored={() => {
                loadEntry();
                setFormKey((k) => k + 1);
              }}
            />
          )}
          <ReferencedBy id={entryId} types={types} />
        </div>
      )}
    </div>
  );
}

import { AiAssistPanel } from '@/components/AiAssistPanel';
import { CollaborationPanel } from '@/components/CollaborationPanel';
import { EntryMetadataPanel } from '@/components/EntryMetadataPanel';
import { ExtensionFrame } from '@/components/ExtensionFrame';
import { PageHeader } from '@/components/PageHeader';
import { ReferencedBy } from '@/components/ReferencedBy';
import { SemanticPanel } from '@/components/SemanticPanel';
import { VersionHistory } from '@/components/VersionHistory';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import type { EntryFields } from '@cw/domain';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, PenLine, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { CanvasDialog } from '../components/CanvasDialog.js';
import type { Pickers } from '../components/EntryForm.js';
import { EntryForm } from '../components/EntryForm.js';
import { GenerateEntryDialog } from '../components/GenerateEntryDialog.js';
import { useClient } from '../lib/client-context.js';
import type { ModelTier } from '../lib/management.js';
import {
  useAllEntriesQuery,
  useAppExtensionsQuery,
  useAssetsQuery,
  useEntryQuery,
  useQueryKeys,
} from '../lib/queries.js';
import { useToast } from '../lib/toast.js';
import { useContentOutlet } from './content-context.js';

/** Create (/content/:typeId/new) or edit (/content/:typeId/:entryId) one entry. */
export function EntryEditor() {
  const { typeId, entryId } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { client, conn, busy, run } = useClient();
  const { types, locales, defaultLocale, fallbacks } = useContentOutlet();
  const queryClient = useQueryClient();
  const keys = useQueryKeys();

  const isEdit = Boolean(entryId);
  const selectedType = types.find((t) => t.apiId === typeId);
  const backTo = `/content/${typeId}`;

  // AI generation/canvas results, merged over the loaded draft until the form
  // is re-seeded from the server (save, restore, or suggestion apply). Bound to
  // the entry they were generated for and reset in-render on navigation
  // (e.g. via a "referenced by" link), so they never leak into another entry.
  const [overrideState, setOverrideState] = useState<{
    target: string;
    fields: EntryFields | null;
  }>({ target: `${typeId}:${entryId ?? 'new'}`, fields: null });
  if (overrideState.target !== `${typeId}:${entryId ?? 'new'}`) {
    setOverrideState({ target: `${typeId}:${entryId ?? 'new'}`, fields: null });
  }
  const overrides =
    overrideState.target === `${typeId}:${entryId ?? 'new'}` ? overrideState.fields : null;
  const setOverrides = (update: (prev: EntryFields | null) => EntryFields | null) =>
    setOverrideState((s) => ({ ...s, fields: update(s.fields) }));
  const [genOpen, setGenOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  // Bumped after a generation/restore to re-seed the form (EntryForm reads `initial` once).
  const [formKey, setFormKey] = useState(0);

  // The existing draft (edit mode) seeds the form's initial values.
  const entryQuery = useEntryQuery(isEdit ? entryId : undefined);
  const meta = entryQuery.data
    ? { version: entryQuery.data.version, status: entryQuery.data.status }
    : null;
  const baseFields = isEdit ? ((entryQuery.data?.fields as EntryFields) ?? null) : {};
  const initial: EntryFields | null =
    baseFields === null ? null : { ...baseFields, ...(overrides ?? {}) };

  // A failed load already toasts via the query cache; leave the broken editor.
  useEffect(() => {
    if (entryQuery.isError) navigate(backTo);
  }, [entryQuery.isError, navigate, backTo]);

  // Build reference/asset picker options (all entries + all assets) for Link
  // fields. Both queries are best-effort; the form still works without them.
  const allEntriesQuery = useAllEntriesQuery();
  const assetsQuery = useAssetsQuery();
  const pickers: Pickers = useMemo(() => {
    const displayFieldOf = new Map(types.map((t) => [t.apiId, t.displayField]));
    return {
      entries: (allEntriesQuery.data ?? []).map((e) => {
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
      assets: (assetsQuery.data ?? []).map((a) => ({
        id: a.id,
        label: String(a.title?.[conn.locale] ?? a.file.fileName),
      })),
    };
  }, [allEntriesQuery.data, assetsQuery.data, types, conn.locale]);

  // Installed UI extensions (sidebar widgets + custom field editors); optional.
  const extensionsQuery = useAppExtensionsQuery();
  const extensions = useMemo(
    () => (extensionsQuery.data ?? []).filter((e) => e.active),
    [extensionsQuery.data],
  );

  // Re-seed the form from the server after a restore or applied AI suggestion.
  const reseedFromServer = async () => {
    if (entryId) await queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
    setOverrides(() => null);
    setFormKey((k) => k + 1);
  };

  const save = (fields: EntryFields) =>
    run(async () => {
      if (!selectedType) return;
      if (isEdit && entryId) await client.updateEntry(entryId, fields);
      else await client.createEntry(selectedType.apiId, fields);
      if (entryId) void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
      void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
      toast.success(isEdit ? 'Draft updated' : 'Entry created');
      navigate(backTo);
    });

  // Generate field values from a prompt and merge them into the form (throws on
  // error so the dialog can surface it; not wrapped in `run`).
  const generate = async (prompt: string, tier: ModelTier) => {
    if (!selectedType) return;
    const res = await client.generateEntry({ contentTypeApiId: selectedType.apiId, prompt, tier });
    setOverrides((prev) => ({ ...(prev ?? {}), ...res.fields }));
    setFormKey((k) => k + 1);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Generated ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  };

  // Canvas: map free-form prose into the form's fields (throws so the dialog can
  // surface the error; not wrapped in `run`).
  const mapCanvas = async (prose: string, tier: ModelTier) => {
    if (!selectedType) return;
    const res = await client.canvasEntry({ contentTypeApiId: selectedType.apiId, prose, tier });
    setOverrides((prev) => ({ ...(prev ?? {}), ...res.fields }));
    setFormKey((k) => k + 1);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Mapped ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  };

  const copyPreviewLink = () => {
    if (!entryId) return;
    void run(async () => {
      const link = await client.createPreviewLink(entryId, {
        previewBaseUrl: conn.baseUrl || window.location.origin,
      });
      await navigator.clipboard.writeText(link.url);
      toast.success(`Preview link copied (expires ${new Date(link.expiresAt).toLocaleString()})`);
    });
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
        <Button type="button" variant="outline" onClick={() => setCanvasOpen(true)}>
          <PenLine className="size-4" /> Canvas
        </Button>
        <Button type="button" variant="outline" onClick={() => setGenOpen(true)}>
          <Sparkles className="size-4" /> Generate with AI
        </Button>
        {isEdit && entryId && (
          <Button type="button" variant="outline" onClick={copyPreviewLink}>
            <Link2 className="size-4" /> Copy preview link
          </Button>
        )}
      </PageHeader>
      {initial === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <EntryForm
          key={`${typeId}:${entryId ?? 'new'}:${formKey}`}
          contentType={selectedType}
          initial={initial}
          locales={locales}
          defaultLocale={defaultLocale}
          fallbacks={fallbacks}
          pickers={pickers}
          fieldEditors={extensions.filter((e) => e.target === 'field-editor')}
          entryContext={{
            spaceId: conn.space,
            environmentId: conn.environment,
            entryId,
            contentType: selectedType.apiId,
          }}
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
      <CanvasDialog
        open={canvasOpen}
        onOpenChange={setCanvasOpen}
        contentTypeName={selectedType.name}
        onMap={mapCanvas}
      />
      {isEdit && entryId && (
        <div className="grid max-w-5xl gap-4 lg:grid-cols-2">
          <AiAssistPanel
            entryId={entryId}
            contentType={selectedType}
            locales={locales}
            defaultLocale={defaultLocale}
            onApplied={() => void reseedFromServer()}
          />
          <CollaborationPanel entryId={entryId} />
          <EntryMetadataPanel entryId={entryId} />
          {meta && (
            <VersionHistory
              entryId={entryId}
              currentVersion={meta.version}
              publishedVersion={meta.status === 'published' ? meta.version : null}
              onRestored={() => void reseedFromServer()}
            />
          )}
          <ReferencedBy id={entryId} types={types} />
          <SemanticPanel entryId={entryId} />
          {extensions
            .filter((e) => e.target === 'sidebar')
            .map((ext) => (
              <Card key={ext.id}>
                <CardHeader>
                  <h2 className="font-heading font-medium text-base">{ext.name}</h2>
                </CardHeader>
                <CardContent>
                  <ExtensionFrame
                    extension={ext}
                    context={{
                      target: 'sidebar',
                      spaceId: conn.space,
                      environmentId: conn.environment,
                      entryId,
                      contentType: selectedType.apiId,
                    }}
                  />
                </CardContent>
              </Card>
            ))}
        </div>
      )}
    </div>
  );
}

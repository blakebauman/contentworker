import { AiAssistPanel } from '@/components/AiAssistPanel';
import { CollaborationPanel } from '@/components/CollaborationPanel';
import { CollapsibleCard } from '@/components/CollapsibleCard';
import { EntryMetadataPanel } from '@/components/EntryMetadataPanel';
import { ExtensionFrame } from '@/components/ExtensionFrame';
import { ReferencedBy } from '@/components/ReferencedBy';
import { SemanticPanel } from '@/components/SemanticPanel';
import { StatusBadge } from '@/components/StatusBadge';
import { VersionHistory } from '@/components/VersionHistory';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import type { EntryFields } from '@cw/domain';
import { useQueryClient } from '@tanstack/react-query';
import { Link2, PenLine, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useBlocker, useNavigate, useParams } from 'react-router-dom';
import { CanvasDialog } from '../components/CanvasDialog.js';
import type { Pickers } from '../components/EntryForm.js';
import { EntryForm } from '../components/EntryForm.js';
import { GenerateEntryDialog } from '../components/GenerateEntryDialog.js';
import { useClient } from '../lib/client-context.js';
import type { EntryAggregate, FieldChange, ModelTier } from '../lib/management.js';
import {
  useAllEntriesQuery,
  useAppExtensionsQuery,
  useAssetsQuery,
  useEntryQuery,
  useQueryKeys,
} from '../lib/queries.js';
import { useToast } from '../lib/toast.js';
import { useContentOutlet } from './content-context.js';

const FORM_ID = 'entry-form';

const submitForm = () =>
  (document.getElementById(FORM_ID) as HTMLFormElement | null)?.requestSubmit();

/**
 * Create (/content/:typeId/new) or edit (/content/:typeId/:entryId) one entry.
 *
 * The editor is a place you stay: saving keeps you here (a new entry navigates
 * to its edit URL), the header always shows status/version/unsaved state, and
 * Publish lives next to Save — with unsaved edits it saves first, then asks for
 * confirmation with a changed-fields summary.
 */
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

  // AI generation/canvas/assist results are merged into the live form via a
  // sequenced patch — the form never remounts for them, so other unsaved edits
  // survive. Bound to the entry they were generated for and reset in-render on
  // navigation (e.g. via a "referenced by" link), so they never leak.
  const [patchState, setPatchState] = useState<{
    target: string;
    patch: { seq: number; fields: EntryFields } | null;
  }>({ target: `${typeId}:${entryId ?? 'new'}`, patch: null });
  // Freshest aggregate we hold (from save/publish responses); backs the
  // publish confirmation's changed-fields diff.
  const [lastAggregate, setLastAggregate] = useState<EntryAggregate | null>(null);
  const [publishConfirm, setPublishConfirm] = useState<{ changes: FieldChange[] | null } | null>(
    null,
  );
  if (patchState.target !== `${typeId}:${entryId ?? 'new'}`) {
    setPatchState({ target: `${typeId}:${entryId ?? 'new'}`, patch: null });
    setLastAggregate(null);
    setPublishConfirm(null);
  }
  const applyPatch = (fields: EntryFields) =>
    setPatchState((s) => ({ ...s, patch: { seq: (s.patch?.seq ?? 0) + 1, fields } }));
  const [genOpen, setGenOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  // Bumped after a restore to re-seed the form (EntryForm reads `initial` once).
  const [formKey, setFormKey] = useState(0);

  // Unsaved-edit tracking: guards in-app navigation and tab close. The
  // generation counter lets `save` detect edits typed WHILE the request was in
  // flight — those must survive the post-save markDirty(false).
  const dirtyRef = useRef(false);
  const dirtyGen = useRef(0);
  const [dirty, setDirty] = useState(false);
  const markDirty = (d: boolean) => {
    if (d) dirtyGen.current += 1;
    dirtyRef.current = d;
    setDirty(d);
  };
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current && currentLocation.pathname !== nextLocation.pathname,
  );
  const blockerProceededRef = useRef(false);
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  // The existing draft (edit mode) seeds the form's initial values.
  const entryQuery = useEntryQuery(isEdit ? entryId : undefined);
  const meta = entryQuery.data
    ? { version: entryQuery.data.version, status: entryQuery.data.status }
    : null;
  const baseFields = isEdit ? ((entryQuery.data?.fields as EntryFields) ?? null) : {};
  const initial: EntryFields | null = baseFields;

  // A failed load already toasts via the query cache; leave the broken editor.
  useEffect(() => {
    if (entryQuery.isError) navigate(backTo);
  }, [entryQuery.isError, navigate, backTo]);

  // Header + tab title: the entry's display-field value when it has one.
  const displayTitle = useMemo(() => {
    const df = selectedType?.displayField;
    const v = df
      ? (baseFields?.[df] as Record<string, unknown> | undefined)?.[defaultLocale]
      : undefined;
    return typeof v === 'string' && v.trim() ? v : null;
  }, [selectedType, baseFields, defaultLocale]);
  const pageTitle =
    displayTitle ??
    (selectedType ? `${isEdit ? 'Edit' : 'New'} ${selectedType.name}` : 'Entry editor');
  useEffect(() => {
    const prev = document.title;
    document.title = `${pageTitle} · contentworker admin`;
    return () => {
      document.title = prev;
    };
  }, [pageTitle]);

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

  // Re-seed the form from the server after a restore (server state changed).
  const reseedFromServer = async () => {
    if (entryId) await queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
    markDirty(false);
    // The aggregate predates the restore; a publish diff based on it would
    // compare the wrong versions.
    setLastAggregate(null);
    setFormKey((k) => k + 1);
  };

  // ⌘S / Ctrl+S saves the draft (validation still runs via the form submit).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        submitForm();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Builds the publish confirmation, diffing published → current when we know
  // the published version (fresh save/publish response). No `run` here: callers
  // wrap it, and `run` doesn't nest.
  const computePublishConfirm = async (agg: EntryAggregate | null) => {
    if (!entryId) return;
    let changes: FieldChange[] | null = null;
    if (agg && agg.publishedVersion != null) {
      const diff = await client.diffVersions(entryId, agg.publishedVersion, agg.currentVersion);
      changes = diff.changes.filter((c) => c.kind !== 'unchanged');
    }
    setPublishConfirm({ changes });
  };

  // Set just before a Publish-triggered form submit; consumed synchronously by
  // `save` (requestSubmit dispatches inline), then cleared either way so a
  // failed validation can't leak the flag into a later plain save.
  const publishAfterSaveRef = useRef(false);

  const save = (fields: EntryFields) => {
    const chainPublish = publishAfterSaveRef.current;
    publishAfterSaveRef.current = false;
    return run(async () => {
      if (!selectedType) return;
      const genAtSubmit = dirtyGen.current;
      const view =
        isEdit && entryId
          ? await client.updateEntry(entryId, fields)
          : await client.createEntry(selectedType.apiId, fields);
      setLastAggregate(view.entry);
      // Edit mode: only clear dirty if nothing was typed while the request was
      // in flight — those keystrokes are NOT in the saved payload. Create mode
      // clears unconditionally: the URL swap below remounts the form from the
      // server state, and blocking our own navigation would trap the user.
      if (!isEdit || dirtyGen.current === genAtSubmit) markDirty(false);
      if (entryId) void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
      void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
      toast.success(isEdit ? 'Draft updated' : 'Entry created');
      if (!isEdit) {
        // Stay in the editor: swap /new for the created entry's edit URL.
        navigate(`/content/${typeId}/${view.entry.id}`, { replace: true });
        return;
      }
      if (chainPublish) await computePublishConfirm(view.entry);
    });
  };

  const requestPublish = () => {
    if (!entryId) return;
    if (dirtyRef.current) {
      // Save first, then confirm publish — one decisive action. If validation
      // fails, the submit never reaches `save` and the flag is cleared below.
      publishAfterSaveRef.current = true;
      submitForm();
      publishAfterSaveRef.current = false;
      return;
    }
    void run(() => computePublishConfirm(lastAggregate?.id === entryId ? lastAggregate : null));
  };

  const confirmPublish = () =>
    run(async () => {
      if (!entryId) return;
      const agg = await client.publishEntry(entryId);
      setLastAggregate(agg);
      void queryClient.invalidateQueries({ queryKey: keys.entry(entryId) });
      void queryClient.invalidateQueries({ queryKey: keys.entriesRoot });
      toast.success(`Published v${agg.publishedVersion ?? agg.currentVersion}`);
      setPublishConfirm(null);
    });

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
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 max-w-2xl" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="truncate font-semibold text-lg tracking-tight">{pageTitle}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            {meta && <StatusBadge status={meta.status} />}
            {meta && <span>v{meta.version}</span>}
            {dirty ? (
              <Badge variant="warning">Unsaved changes</Badge>
            ) : (
              isEdit && meta && <span>All changes saved</span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" onClick={() => setCanvasOpen(true)}>
            <PenLine className="size-4" /> Draft from prose
          </Button>
          <Button type="button" variant="outline" onClick={() => setGenOpen(true)}>
            <Sparkles className="size-4" /> Generate with AI
          </Button>
          {isEdit && entryId && (
            <Button type="button" variant="outline" onClick={copyPreviewLink}>
              <Link2 className="size-4" /> Copy preview link
            </Button>
          )}
          <Button type="submit" form={FORM_ID} disabled={busy || initial === null}>
            Save draft
          </Button>
          {isEdit && (
            <Button
              type="button"
              variant="outline"
              // A published entry with UNSAVED edits can still publish: the
              // click saves first (status becomes "changed"), then confirms.
              disabled={busy || (meta?.status === 'published' && !dirty)}
              onClick={requestPublish}
            >
              {meta?.status === 'published' && !dirty ? 'Published' : 'Publish'}
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
        <div className="min-w-0 flex-1">
          {initial === null ? (
            <div className="max-w-2xl space-y-3">
              <Skeleton className="h-8 w-1/3" />
              <Skeleton className="h-24" />
              <Skeleton className="h-24" />
            </div>
          ) : (
            <EntryForm
              key={`${typeId}:${entryId ?? 'new'}:${formKey}`}
              formId={FORM_ID}
              hideActions
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
              onDirtyChange={markDirty}
              onValidationFailed={(count) => {
                // Called synchronously from the submit; the publish flag is
                // still set when this was a Publish-triggered save.
                const goal = publishAfterSaveRef.current ? 'publish' : 'save';
                toast.error(`Fix ${count} field ${count === 1 ? 'error' : 'errors'} to ${goal}`);
              }}
              mergePatch={patchState.patch}
              onSave={save}
              onCancel={() => navigate(backTo)}
            />
          )}
        </div>

        {/* Panels are keyed by entry so proposal/draft/diff state can never
            survive an entry-to-entry navigation and act on the wrong entry. */}
        {isEdit && entryId && (
          <aside className="w-full shrink-0 space-y-4 xl:w-[380px]">
            <AiAssistPanel
              key={entryId}
              entryId={entryId}
              contentType={selectedType}
              locales={locales}
              defaultLocale={defaultLocale}
              onMergeFields={applyPatch}
            />
            <CollaborationPanel key={entryId} entryId={entryId} />
            <EntryMetadataPanel key={entryId} entryId={entryId} />
            {meta && (
              <VersionHistory
                key={entryId}
                entryId={entryId}
                currentVersion={meta.version}
                publishedVersion={
                  lastAggregate?.id === entryId
                    ? lastAggregate.publishedVersion
                    : meta.status === 'published'
                      ? meta.version
                      : null
                }
                hasUnsavedChanges={() => dirtyRef.current}
                onRestored={() => void reseedFromServer()}
              />
            )}
            <ReferencedBy id={entryId} types={types} />
            <SemanticPanel entryId={entryId} entries={pickers.entries} />
            {extensions
              .filter((e) => e.target === 'sidebar')
              .map((ext) => (
                <CollapsibleCard key={ext.id} defaultOpen title={ext.name}>
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
                </CollapsibleCard>
              ))}
          </aside>
        )}
      </div>

      <AlertDialog
        open={blocker.state === 'blocked'}
        onOpenChange={(open) => {
          // Radix fires onOpenChange(false) after the action's onClick; if the
          // user chose to proceed, don't follow up with a reset().
          if (!open && blocker.state === 'blocked' && !blockerProceededRef.current) {
            blocker.reset();
          }
          if (open) blockerProceededRef.current = false;
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This entry has edits that haven’t been saved. Leaving now will discard them.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => blocker.state === 'blocked' && blocker.reset()}>
              Keep editing
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (blocker.state !== 'blocked') return;
                blockerProceededRef.current = true;
                markDirty(false);
                blocker.proceed();
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={publishConfirm !== null}
        onOpenChange={(open) => {
          if (!open) setPublishConfirm(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Publish “{pageTitle}”?</AlertDialogTitle>
            <AlertDialogDescription>
              {publishConfirm?.changes
                ? publishConfirm.changes.length === 0
                  ? 'The draft matches the published version; publishing re-confirms it.'
                  : `${publishConfirm.changes.length} ${
                      publishConfirm.changes.length === 1 ? 'field goes' : 'fields go'
                    } live:`
                : meta?.status === 'draft'
                  ? 'This entry hasn’t been published before, so the whole entry goes live.'
                  : 'Everything changed since the last publish goes live.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {publishConfirm?.changes && publishConfirm.changes.length > 0 && (
            <ul className="max-h-48 space-y-1 overflow-y-auto text-sm">
              {publishConfirm.changes.map((c) => (
                <li key={c.field} className="flex items-center gap-2">
                  <span className="font-medium">
                    {selectedType.fields.find((f) => f.apiId === c.field)?.name ?? c.field}
                  </span>
                  <Badge variant="outline" className="capitalize">
                    {c.kind}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>Keep as draft</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={() => void confirmPublish()}>
              Publish entry
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

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
    </div>
  );

  // Generate field values from a prompt and merge them into the form (throws on
  // error so the dialog can surface it; not wrapped in `run`).
  async function generate(prompt: string, tier: ModelTier) {
    if (!selectedType) return;
    const res = await client.generateEntry({ contentTypeApiId: selectedType.apiId, prompt, tier });
    applyPatch(res.fields);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Generated ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  }

  // Canvas: map free-form prose into the form's fields (throws so the dialog can
  // surface the error; not wrapped in `run`).
  async function mapCanvas(prose: string, tier: ModelTier) {
    if (!selectedType) return;
    const res = await client.canvasEntry({ contentTypeApiId: selectedType.apiId, prose, tier });
    applyPatch(res.fields);
    const total = res.usage.inputTokens + res.usage.outputTokens;
    toast.success(`Mapped ${Object.keys(res.fields).length} field(s) · ${total} tokens`);
  }
}

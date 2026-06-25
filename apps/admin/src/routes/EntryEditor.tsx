import type { EntryFields } from '@cw/domain';
import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import type { Pickers } from '../components/EntryForm.js';
import { EntryForm } from '../components/EntryForm.js';
import { useClient } from '../lib/client-context.js';
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
  const [pickers, setPickers] = useState<Pickers>({ entries: [], assets: [] });

  // Load the existing draft (edit mode) into the form's initial values.
  useEffect(() => {
    if (!isEdit || !entryId) return;
    let live = true;
    client
      .getEntry(entryId)
      .then((e) => live && setInitial(e.fields as EntryFields))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : String(err));
        if (live) navigate(backTo);
      });
    return () => {
      live = false;
    };
  }, [client, entryId, isEdit, navigate, backTo, toast]);

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

  if (!selectedType) {
    return <p className="text-muted-foreground">Loading…</p>;
  }

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">
        {isEdit ? 'Edit' : 'New'} {selectedType.name}
      </h1>
      {initial === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : (
        <EntryForm
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
    </div>
  );
}

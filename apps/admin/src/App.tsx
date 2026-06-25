import type { ContentType, EntryFields } from '@cw/domain';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ConnectionBar } from './components/ConnectionBar.js';
import { Dashboard } from './components/Dashboard.js';
import { EntryDiff } from './components/EntryDiff.js';
import { EntryForm, type Pickers } from './components/EntryForm.js';
import { MediaLibrary } from './components/MediaLibrary.js';
import { Settings } from './components/Settings.js';
import { useConnection } from './lib/connection.js';
import { type PreviewEntry, type SpaceConfig, createManagementClient } from './lib/management.js';
import { useToast } from './lib/toast.js';

type Editing = { mode: 'new' } | { mode: 'edit'; id: string } | null;
type LocaleConfig = { locales: readonly string[]; defaultLocale: string };
type View = 'content' | 'media' | 'dashboard' | 'settings';

export function App() {
  const toast = useToast();
  const [conn, updateConn] = useConnection();
  const client = useMemo(() => createManagementClient(conn), [conn]);

  const [types, setTypes] = useState<ContentType[]>([]);
  const [selected, setSelected] = useState<string | undefined>();
  const [entries, setEntries] = useState<PreviewEntry[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [editInitial, setEditInitial] = useState<EntryFields>({});
  // Locales for the editor's localization tabs; falls back to the connection locale.
  const [localeCfg, setLocaleCfg] = useState<LocaleConfig>({
    locales: [conn.locale],
    defaultLocale: conn.locale,
  });
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<View>('content');
  const [pickers, setPickers] = useState<Pickers>({ entries: [], assets: [] });
  // Publishing workflow: multi-select for bulk actions + a draft-vs-published diff panel.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [diffEntry, setDiffEntry] = useState<PreviewEntry | null>(null);

  const run = useCallback(
    async (fn: () => Promise<void>) => {
      setBusy(true);
      try {
        await fn();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );

  const loadTypes = useCallback(
    () =>
      run(async () => {
        const [ts, cfg] = await Promise.all([
          client.listContentTypes(),
          client.getSpaceConfig().catch((): SpaceConfig | null => null),
        ]);
        setTypes(ts);
        if (cfg) setLocaleCfg({ locales: cfg.locales, defaultLocale: cfg.defaultLocale });
      }),
    [client, run],
  );
  const loadEntries = useCallback(
    (ct: string) => run(async () => setEntries(await client.listEntries(ct))),
    [client, run],
  );

  // Reload content types whenever the connection (client) changes.
  useEffect(() => {
    loadTypes();
  }, [loadTypes]);

  const selectType = (apiId: string) => {
    setSelected(apiId);
    setEditing(null);
    setPicked(new Set());
    setDiffEntry(null);
    loadEntries(apiId);
  };

  const togglePick = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const bulk = (action: (id: string) => Promise<unknown>, verb: string) =>
    run(async () => {
      const n = picked.size;
      for (const id of picked) await action(id);
      setPicked(new Set());
      if (selected) await loadEntries(selected);
      toast.success(`${verb} ${n} ${n === 1 ? 'entry' : 'entries'}`);
    });

  // Build reference/asset picker options (all entries + all assets) for the form.
  const loadPickers = useCallback(
    () =>
      run(async () => {
        const [allEntries, assets] = await Promise.all([client.listEntries(), client.listAssets()]);
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
      }),
    [client, run, types, conn.locale],
  );

  const openForm = (next: Editing, initial: EntryFields) => {
    setEditInitial(initial);
    setEditing(next);
    void loadPickers();
  };

  const selectedType = types.find((t) => t.apiId === selected);

  // Preview fields are already the localized shape the form edits directly.
  const openEdit = (e: PreviewEntry) =>
    openForm({ mode: 'edit', id: e.id }, e.fields as EntryFields);

  const save = (fields: EntryFields) =>
    run(async () => {
      if (!selectedType) return;
      const editingNow = editing?.mode === 'edit';
      if (editing?.mode === 'edit') await client.updateEntry(editing.id, fields);
      else await client.createEntry(selectedType.apiId, fields);
      setEditing(null);
      await loadEntries(selectedType.apiId);
      toast.success(editingNow ? 'Draft updated' : 'Entry created');
    });

  const publish = (id: string) =>
    run(async () => {
      await client.publishEntry(id);
      if (selected) await loadEntries(selected);
      toast.success('Entry published');
    });
  const unpublish = (id: string) =>
    run(async () => {
      await client.unpublishEntry(id);
      if (selected) await loadEntries(selected);
      toast.success('Entry unpublished');
    });

  return (
    <div className="app">
      <ConnectionBar conn={conn} onChange={updateConn} onReload={loadTypes} />
      <div className="main">
        <aside className="sidebar">
          <div className="row" style={{ padding: 8, gap: 4 }}>
            <button
              type="button"
              className={view === 'content' ? '' : 'ghost'}
              onClick={() => setView('content')}
            >
              Content
            </button>
            <button
              type="button"
              className={view === 'media' ? '' : 'ghost'}
              onClick={() => setView('media')}
            >
              Media
            </button>
            <button
              type="button"
              className={view === 'dashboard' ? '' : 'ghost'}
              onClick={() => setView('dashboard')}
            >
              Dashboard
            </button>
            <button
              type="button"
              className={view === 'settings' ? '' : 'ghost'}
              onClick={() => setView('settings')}
            >
              Settings
            </button>
          </div>
          {view === 'content' && (
            <>
              <div className="muted" style={{ padding: 8 }}>
                Content types
              </div>
              {types.map((t) => (
                <button
                  type="button"
                  key={t.apiId}
                  className={`item ${t.apiId === selected ? 'active' : ''}`}
                  style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none' }}
                  onClick={() => selectType(t.apiId)}
                >
                  {t.name} <span className="muted">{t.status}</span>
                </button>
              ))}
              {types.length === 0 && (
                <div className="muted" style={{ padding: 8 }}>
                  No content types.
                </div>
              )}
            </>
          )}
        </aside>

        <section className="content">
          {view === 'media' && <MediaLibrary client={client} locale={conn.locale} />}

          {view === 'dashboard' && <Dashboard client={client} />}

          {view === 'settings' && <Settings client={client} />}

          {view === 'content' && (
            <>
              {!selectedType && (
                <p className="muted">Select a content type to browse its entries.</p>
              )}

              {selectedType && !editing && (
                <>
                  <div className="row between">
                    <h1 className="h">{selectedType.name} entries</h1>
                    <div className="row" style={{ gap: 8 }}>
                      {picked.size > 0 && (
                        <>
                          <span className="muted">{picked.size} selected</span>
                          <button
                            type="button"
                            onClick={() => bulk((id) => client.publishEntry(id), 'Published')}
                            disabled={busy}
                          >
                            Publish selected
                          </button>
                          <button
                            type="button"
                            className="ghost"
                            onClick={() => bulk((id) => client.unpublishEntry(id), 'Unpublished')}
                            disabled={busy}
                          >
                            Unpublish selected
                          </button>
                        </>
                      )}
                      <button
                        type="button"
                        onClick={() => openForm({ mode: 'new' }, {})}
                        disabled={busy}
                      >
                        + New entry
                      </button>
                    </div>
                  </div>
                  <table>
                    <thead>
                      <tr>
                        <th style={{ width: 32 }} />
                        <th>{selectedType.displayField}</th>
                        <th>Status</th>
                        <th style={{ width: 300 }}>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {entries.map((e) => (
                        <tr key={e.id}>
                          <td>
                            <input
                              type="checkbox"
                              aria-label={`Select ${e.id}`}
                              checked={picked.has(e.id)}
                              onChange={() => togglePick(e.id)}
                              style={{ width: 'auto' }}
                            />
                          </td>
                          <td>
                            {String(
                              (e.fields[selectedType.displayField] as Record<string, unknown>)?.[
                                conn.locale
                              ] ?? '—',
                            )}
                          </td>
                          <td>
                            <span className={`badge ${e.status}`}>{e.status}</span>
                          </td>
                          <td className="row">
                            <button
                              type="button"
                              className="ghost"
                              onClick={() => openEdit(e)}
                              disabled={busy}
                            >
                              Edit
                            </button>
                            {e.status !== 'draft' && (
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => setDiffEntry(diffEntry?.id === e.id ? null : e)}
                                disabled={busy}
                              >
                                Diff
                              </button>
                            )}
                            <button type="button" onClick={() => publish(e.id)} disabled={busy}>
                              Publish
                            </button>
                            {e.status === 'published' && (
                              <button
                                type="button"
                                className="ghost"
                                onClick={() => unpublish(e.id)}
                                disabled={busy}
                              >
                                Unpublish
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                      {entries.length === 0 && (
                        <tr>
                          <td colSpan={4} className="muted">
                            No entries yet.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                  {diffEntry && (
                    <EntryDiff
                      client={client}
                      entry={diffEntry}
                      locale={conn.locale}
                      onClose={() => setDiffEntry(null)}
                    />
                  )}
                </>
              )}

              {selectedType && editing && (
                <>
                  <h1 className="h">
                    {editing.mode === 'new' ? 'New' : 'Edit'} {selectedType.name}
                  </h1>
                  <EntryForm
                    contentType={selectedType}
                    initial={editInitial}
                    locales={localeCfg.locales}
                    defaultLocale={localeCfg.defaultLocale}
                    pickers={pickers}
                    busy={busy}
                    onSave={save}
                    onCancel={() => setEditing(null)}
                  />
                </>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}

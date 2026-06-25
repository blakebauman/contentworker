import { useEffect, useState } from 'react';
import type { ManagementClient, PreviewEntry } from '../lib/management.js';

/** A single field's draft-vs-published comparison. */
interface FieldDelta {
  readonly apiId: string;
  readonly published: unknown;
  readonly draft: unknown;
  readonly changed: boolean;
}

const show = (v: unknown): string => {
  if (v === undefined || v === null) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
};

/**
 * Compares an entry's current draft against its published version. Draft fields
 * come from Preview (localized shape), published from Delivery (locale-collapsed,
 * links embedded) — so we unwrap the draft to the connection locale before diffing.
 */
export function EntryDiff(props: {
  client: ManagementClient;
  entry: PreviewEntry;
  locale: string;
  onClose: () => void;
}) {
  const { client, entry, locale, onClose } = props;
  const [deltas, setDeltas] = useState<FieldDelta[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const published = await client.getPublished(entry.id);
        if (!live) return;
        const keys = new Set([...Object.keys(entry.fields), ...Object.keys(published.fields)]);
        const rows: FieldDelta[] = [];
        for (const apiId of keys) {
          const raw = entry.fields[apiId];
          const draft =
            raw && typeof raw === 'object' ? (raw as Record<string, unknown>)[locale] : raw;
          const pub = published.fields[apiId];
          rows.push({
            apiId,
            draft,
            published: pub,
            changed: JSON.stringify(draft ?? null) !== JSON.stringify(pub ?? null),
          });
        }
        setDeltas(rows.sort((a, b) => Number(b.changed) - Number(a.changed)));
      } catch (e) {
        // A draft that was never published has no delivery row (404) — say so plainly.
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [client, entry, locale]);

  const changedCount = deltas?.filter((d) => d.changed).length ?? 0;

  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 16, marginTop: 12 }}>
      <div className="row between">
        <h2 className="h" style={{ fontSize: 15 }}>
          Diff vs published{deltas && <span className="muted"> · {changedCount} changed</span>}
        </h2>
        <button type="button" className="ghost" onClick={onClose}>
          Close
        </button>
      </div>
      {error && <div className="error">⚠ {error}</div>}
      {deltas && (
        <table>
          <thead>
            <tr>
              <th style={{ width: 160 }}>Field</th>
              <th>Published</th>
              <th>Draft</th>
            </tr>
          </thead>
          <tbody>
            {deltas.map((d) => (
              <tr
                key={d.apiId}
                style={d.changed ? { background: 'rgba(255,200,0,0.06)' } : undefined}
              >
                <td>
                  {d.changed && <span style={{ color: 'var(--accent)' }}>● </span>}
                  {d.apiId}
                </td>
                <td className="muted">{show(d.published).slice(0, 200)}</td>
                <td>{show(d.draft).slice(0, 200)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

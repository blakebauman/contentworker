import type { Connection } from '../lib/management.js';

const FIELDS: { key: keyof Connection; label: string; size: number }[] = [
  { key: 'baseUrl', label: 'API URL', size: 22 },
  { key: 'token', label: 'Token', size: 16 },
  { key: 'space', label: 'Space', size: 10 },
  { key: 'environment', label: 'Env', size: 8 },
  { key: 'locale', label: 'Locale', size: 7 },
];

/** Top bar to configure the API connection (persisted to localStorage). */
export function ConnectionBar(props: {
  conn: Connection;
  onChange: (patch: Partial<Connection>) => void;
  onReload: () => void;
}) {
  return (
    <div className="bar">
      <strong>contentworker</strong>
      {FIELDS.map((f) => (
        <input
          key={f.key}
          aria-label={f.label}
          placeholder={f.label}
          size={f.size}
          type={f.key === 'token' ? 'password' : 'text'}
          value={props.conn[f.key]}
          onChange={(e) => props.onChange({ [f.key]: e.target.value })}
        />
      ))}
      <span className="grow" />
      <button type="button" className="ghost" onClick={props.onReload}>
        Reload
      </button>
    </div>
  );
}

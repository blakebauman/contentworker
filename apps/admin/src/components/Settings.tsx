import { useCallback, useEffect, useState } from 'react';
import {
  type ApiKeyKind,
  type ApiKeySummary,
  type CreatedApiKey,
  type ManagementClient,
  WEBHOOK_TOPICS,
  type WebhookSummary,
  type WebhookTopic,
} from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/** Space settings: API key issuance + webhook subscriptions (space-admin scope). */
export function Settings(props: { client: ManagementClient }) {
  const { client } = props;

  return (
    <>
      <h1 className="h">Settings</h1>
      <ApiKeys client={client} />
      <Webhooks client={client} />
    </>
  );
}

function ApiKeys(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [keys, setKeys] = useState<ApiKeySummary[]>([]);
  const [kind, setKind] = useState<ApiKeyKind>('cda');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // The raw token is shown exactly once, right after minting.
  const [minted, setMinted] = useState<CreatedApiKey>();

  const load = useCallback(async () => {
    try {
      setKeys(await client.listApiKeys());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await client.createApiKey({ kind, name: name.trim() || undefined });
      setMinted(created);
      setName('');
      await load();
      toast.success(`${created.kind.toUpperCase()} key created`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section style={{ marginBottom: 28 }}>
      <h2 className="h" style={{ fontSize: 15 }}>
        API keys
      </h2>

      {minted && (
        <div
          className="row between"
          style={{
            border: '1px solid var(--accent)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
            gap: 8,
          }}
        >
          <div>
            <div className="muted">
              New {minted.kind.toUpperCase()} token — copy it now, it won't be shown again.
            </div>
            <code style={{ wordBreak: 'break-all' }}>{minted.token}</code>
          </div>
          <button
            type="button"
            className="ghost"
            onClick={() => navigator.clipboard?.writeText(minted.token)}
          >
            Copy
          </button>
        </div>
      )}

      <form className="row" onSubmit={create} style={{ marginBottom: 12, gap: 8 }}>
        <select value={kind} onChange={(e) => setKind(e.target.value as ApiKeyKind)}>
          <option value="cda">CDA — Delivery (read published)</option>
          <option value="cpa">CPA — Preview (read drafts)</option>
          <option value="cma">CMA — Management (full author/publish)</option>
        </select>
        <input
          placeholder="Name (optional)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>

      <table>
        <thead>
          <tr>
            <th style={{ width: 70 }}>Kind</th>
            <th>Name</th>
            <th>Scopes</th>
            <th style={{ width: 90 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr key={k.id}>
              <td>
                <span className="badge published">{k.kind.toUpperCase()}</span>
              </td>
              <td>{k.name ?? <span className="muted">—</span>}</td>
              <td className="muted">{k.scopes.join(', ')}</td>
              <td>
                <span className={`badge ${k.revoked ? 'draft' : 'published'}`}>
                  {k.revoked ? 'revoked' : 'active'}
                </span>
              </td>
            </tr>
          ))}
          {keys.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                No API keys yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

function Webhooks(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [hooks, setHooks] = useState<WebhookSummary[]>([]);
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [topics, setTopics] = useState<WebhookTopic[]>(['*']);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setHooks(await client.listWebhooks());
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleTopic = (t: WebhookTopic) =>
    setTopics((prev) => (prev.includes(t) ? prev.filter((x) => x !== t) : [...prev, t]));

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!url.trim() || !secret.trim() || topics.length === 0) return;
    setBusy(true);
    try {
      await client.createWebhook({ url: url.trim(), secret: secret.trim(), topics });
      setUrl('');
      setSecret('');
      setTopics(['*']);
      await load();
      toast.success('Webhook added');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section>
      <h2 className="h" style={{ fontSize: 15 }}>
        Webhooks
      </h2>

      <form onSubmit={create} style={{ marginBottom: 12 }}>
        <div className="row" style={{ gap: 8, marginBottom: 8 }}>
          <input
            placeholder="https://example.com/hooks/cms"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            style={{ flex: 2 }}
          />
          <input
            placeholder="Signing secret"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add webhook'}
          </button>
        </div>
        <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
          {WEBHOOK_TOPICS.map((t) => (
            <label key={t} className="row" style={{ gap: 4, width: 'auto' }}>
              <input
                type="checkbox"
                checked={topics.includes(t)}
                onChange={() => toggleTopic(t)}
                style={{ width: 'auto' }}
              />
              <span>{t}</span>
            </label>
          ))}
        </div>
      </form>

      <table>
        <thead>
          <tr>
            <th>Endpoint</th>
            <th>Topics</th>
            <th style={{ width: 90 }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {hooks.map((h) => (
            <tr key={h.id}>
              <td style={{ wordBreak: 'break-all' }}>{h.url}</td>
              <td className="muted">{h.topics.join(', ')}</td>
              <td>
                <span className={`badge ${h.active ? 'published' : 'draft'}`}>
                  {h.active ? 'active' : 'paused'}
                </span>
              </td>
            </tr>
          ))}
          {hooks.length === 0 && (
            <tr>
              <td colSpan={3} className="muted">
                No webhooks yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </section>
  );
}

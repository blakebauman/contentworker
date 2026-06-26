import { PageHeader } from '@/components/PageHeader';
import { StatusBadge } from '@/components/StatusBadge';
import { WebhookDeliveriesSheet } from '@/components/WebhookDeliveriesSheet';
import { WebhookDialog } from '@/components/WebhookDialog';
import { Alert, AlertAction, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { KeyRound } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import {
  type ApiKeyKind,
  type ApiKeySummary,
  type Connection,
  type CreatedApiKey,
  type Environment,
  type EnvironmentAlias,
  type ManagementClient,
  WEBHOOK_TOPICS,
  type WebhookSummary,
  type WebhookTopic,
} from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/**
 * Space settings, organized as URL-driven tabs (`/settings/:section`): API key
 * issuance, webhook subscriptions, and the API connection config.
 */
export function Settings(props: {
  client: ManagementClient;
  section: string;
  onSection: (section: string) => void;
}) {
  const { client, section, onSection } = props;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader
        title="Settings"
        description="API keys, webhooks, and the API connection for this space."
      />
      <Tabs value={section} onValueChange={onSection}>
        <TabsList>
          <TabsTrigger value="api-keys">API keys</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="environments">Environments</TabsTrigger>
          <TabsTrigger value="connection">Connection</TabsTrigger>
        </TabsList>
        <TabsContent value="api-keys" className="mt-4">
          <ApiKeys client={client} />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <Webhooks client={client} />
        </TabsContent>
        <TabsContent value="environments" className="mt-4">
          <Environments client={client} />
        </TabsContent>
        <TabsContent value="connection" className="mt-4">
          <ConnectionSettings />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** Environments + repointable aliases (blue/green). An alias resolves to a
 *  target environment anywhere `:env` is accepted; repointing is atomic cutover. */
function Environments(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const [environments, setEnvironments] = useState<Environment[]>([]);
  const [aliases, setAliases] = useState<EnvironmentAlias[]>([]);
  const [alias, setAlias] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [envs, als] = await Promise.all([
        client.listEnvironments(),
        client.listEnvironmentAliases(),
      ]);
      setEnvironments(envs);
      setAliases(als);
      setTarget((t) => t || envs[0]?.id || '');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  }, [client, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await client.setEnvironmentAlias(alias.trim(), target);
      setAlias('');
      await load();
      toast.success(`Alias “${alias.trim()}” → ${target}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    try {
      await client.deleteEnvironmentAlias(name);
      await load();
      toast.success('Alias deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const repoint = async (name: string, targetEnvironmentId: string) => {
    try {
      await client.setEnvironmentAlias(name, targetEnvironmentId);
      await load();
      toast.success(`“${name}” → ${targetEnvironmentId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">Environments</h2>
        </CardHeader>
        <CardContent>
          {environments.length === 0 ? (
            <p className="text-muted-foreground text-sm">No environments.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {environments.map((e) => (
                <Badge key={e.id} variant="outline">
                  {e.id}
                </Badge>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-heading font-medium text-base">Aliases</h2>
          <p className="text-muted-foreground text-sm">
            A repointable pointer to an environment. Use it as the environment in any API call;
            repoint it for an atomic blue/green cutover.
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          <form onSubmit={save} className="flex flex-wrap items-end gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="alias-name">Alias</Label>
              <Input
                id="alias-name"
                value={alias}
                onChange={(e) => setAlias(e.target.value)}
                placeholder="production"
              />
            </div>
            <div className="space-y-1.5">
              <Label>Target environment</Label>
              <Select value={target} onValueChange={setTarget}>
                <SelectTrigger className="w-[200px]">
                  <SelectValue placeholder="Environment" />
                </SelectTrigger>
                <SelectContent>
                  {environments.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="submit" disabled={!alias.trim() || !target || busy}>
              Save alias
            </Button>
          </form>

          {aliases.length === 0 ? (
            <p className="text-muted-foreground text-sm">No aliases yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Alias</TableHead>
                  <TableHead>Target</TableHead>
                  <TableHead className="w-24" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {aliases.map((a) => (
                  <TableRow key={a.alias}>
                    <TableCell className="font-medium">{a.alias}</TableCell>
                    <TableCell>
                      <Select
                        value={a.targetEnvironmentId}
                        onValueChange={(v) => repoint(a.alias, v)}
                      >
                        <SelectTrigger className="h-8 w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {environments.map((e) => (
                            <SelectItem key={e.id} value={e.id}>
                              {e.id}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => remove(a.alias)}
                      >
                        Delete
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

const KEY_KINDS: { value: ApiKeyKind; label: string }[] = [
  { value: 'cda', label: 'CDA — Delivery (read published)' },
  { value: 'cpa', label: 'CPA — Preview (read drafts)' },
  { value: 'cma', label: 'CMA — Management (full author/publish)' },
];

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

  const revoke = async (id: string) => {
    try {
      await client.revokeApiKey(id);
      await load();
      toast.success('Key revoked');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        {/* Explicit heading element — the e2e asserts getByRole('heading', { name: 'API keys' }). */}
        <h2 className="font-heading text-base font-medium">API keys</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        {minted && (
          <Alert>
            <KeyRound />
            <AlertTitle>
              New {minted.kind.toUpperCase()} token — copy it now, it won't be shown again.
            </AlertTitle>
            <AlertDescription>
              <code className="break-all text-sm text-foreground">{minted.token}</code>
            </AlertDescription>
            <AlertAction>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => navigator.clipboard?.writeText(minted.token)}
              >
                Copy
              </Button>
            </AlertAction>
          </Alert>
        )}

        <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
          <Select value={kind} onValueChange={(v) => setKind(v as ApiKeyKind)}>
            <SelectTrigger className="w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KEY_KINDS.map((k) => (
                <SelectItem key={k.value} value={k.value}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Input
            className="w-48"
            placeholder="Name (optional)"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create key'}
          </Button>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-20">Kind</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((k) => (
              <TableRow key={k.id}>
                <TableCell>
                  <Badge variant="outline">{k.kind.toUpperCase()}</Badge>
                </TableCell>
                <TableCell>{k.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
                <TableCell className="text-muted-foreground">
                  <div className="max-w-[360px] truncate" title={k.scopes.join(', ')}>
                    {k.scopes.join(', ')}
                  </div>
                </TableCell>
                <TableCell>
                  <StatusBadge status={k.revoked ? 'revoked' : 'active'} />
                </TableCell>
                <TableCell className="text-right">
                  {!k.revoked && (
                    <RevokeKeyButton
                      name={k.name ?? k.kind.toUpperCase()}
                      onConfirm={() => revoke(k.id)}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {keys.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground">
                  No API keys yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Destructive "Revoke" action behind a confirm dialog — revoking is permanent. */
function RevokeKeyButton(props: { name: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-destructive">
          Revoke
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{props.name}”?</AlertDialogTitle>
          <AlertDialogDescription>
            This immediately and permanently disables the key. Any client using its token will stop
            working. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Revoke key</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
  const [editing, setEditing] = useState<WebhookSummary | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookSummary | null>(null);

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

  const toggleActive = async (h: WebhookSummary) => {
    try {
      await client.updateWebhook(h.id, { active: !h.active });
      await load();
      toast.success(h.active ? 'Webhook paused' : 'Webhook resumed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await client.deleteWebhook(id);
      await load();
      toast.success('Webhook deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const saveEdit = async (changes: {
    url: string;
    topics: WebhookTopic[];
    active: boolean;
    secret?: string;
  }) => {
    if (!editing) return;
    await client.updateWebhook(editing.id, changes);
    await load();
    toast.success('Webhook updated');
  };

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
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Webhooks</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={create} className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="flex-2 min-w-56"
              placeholder="https://example.com/hooks/cms"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <Input
              className="flex-1 min-w-40"
              placeholder="Signing secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding…' : 'Add webhook'}
            </Button>
          </div>
          <div className="flex flex-wrap gap-4">
            {WEBHOOK_TOPICS.map((t) => (
              <Label key={t} className="flex items-center gap-2 font-normal">
                <Checkbox checked={topics.includes(t)} onCheckedChange={() => toggleTopic(t)} />
                <span>{t}</span>
              </Label>
            ))}
          </div>
        </form>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead>Topics</TableHead>
              <TableHead className="w-24">Status</TableHead>
              <TableHead className="w-64" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {hooks.map((h) => (
              <TableRow key={h.id}>
                <TableCell className="break-all">{h.url}</TableCell>
                <TableCell className="text-muted-foreground">{h.topics.join(', ')}</TableCell>
                <TableCell>
                  <StatusBadge status={h.active ? 'active' : 'paused'} />
                </TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDeliveriesFor(h)}
                    >
                      Deliveries
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => toggleActive(h)}>
                      {h.active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(h)}>
                      Edit
                    </Button>
                    <DeleteWebhookButton url={h.url} onConfirm={() => remove(h.id)} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {hooks.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-muted-foreground">
                  No webhooks yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
      {editing && (
        <WebhookDialog
          key={editing.id}
          open
          onOpenChange={(o) => !o && setEditing(null)}
          webhook={editing}
          onSave={saveEdit}
        />
      )}
      {deliveriesFor && (
        <WebhookDeliveriesSheet
          key={deliveriesFor.id}
          open
          onOpenChange={(o) => !o && setDeliveriesFor(null)}
          webhook={deliveriesFor}
        />
      )}
    </Card>
  );
}

/** Destructive "Delete" action behind a confirm dialog. */
function DeleteWebhookButton(props: { url: string; onConfirm: () => void }) {
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" className="text-destructive">
          Delete
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete webhook?</AlertDialogTitle>
          <AlertDialogDescription>
            Stop delivering events to <span className="break-all font-mono">{props.url}</span> and
            remove this subscription. This can’t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={props.onConfirm}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

const CONN_FIELDS: {
  key: keyof Connection;
  label: string;
  placeholder: string;
  password?: boolean;
}[] = [
  { key: 'baseUrl', label: 'API URL', placeholder: 'same-origin (leave blank to use this host)' },
  { key: 'token', label: 'Token', placeholder: 'CMA or admin token', password: true },
  { key: 'space', label: 'Space', placeholder: 'space-1' },
  { key: 'environment', label: 'Environment', placeholder: 'main' },
];

/**
 * The API connection config that used to live in the always-visible top bar.
 * Edits apply immediately (the client re-memoizes on change); "Test connection"
 * verifies the space is reachable.
 */
function ConnectionSettings() {
  const { conn, updateConn, client } = useClient();
  const toast = useToast();
  const [testing, setTesting] = useState(false);

  const test = async () => {
    setTesting(true);
    try {
      const cfg = await client.getSpaceConfig();
      toast.success(`Connected to ${cfg.name} · ${cfg.locales.length} locale(s)`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Connection</h2>
      </CardHeader>
      <CardContent className="max-w-xl space-y-4">
        {CONN_FIELDS.map((f) => (
          <div key={f.key} className="space-y-1.5">
            <Label htmlFor={`conn-${f.key}`}>{f.label}</Label>
            <Input
              id={`conn-${f.key}`}
              type={f.password ? 'password' : 'text'}
              placeholder={f.placeholder}
              value={conn[f.key]}
              onChange={(e) => updateConn({ [f.key]: e.target.value })}
            />
          </div>
        ))}
        <p className="text-sm text-muted-foreground">
          Changes apply immediately. The default editing locale is set from the topbar locale
          switcher.
        </p>
        <Button type="button" variant="outline" onClick={test} disabled={testing}>
          {testing ? 'Testing…' : 'Test connection'}
        </Button>
      </CardContent>
    </Card>
  );
}

import { AiActions } from '@/components/AiActions';
import { AppExtensions } from '@/components/AppExtensions';
import { BranchMerge } from '@/components/BranchMerge';
import { Functions } from '@/components/Functions';
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
import { useMemo, useState } from 'react';
import { useClient } from '../lib/client-context.js';
import {
  type ApiKeyKind,
  type Connection,
  type CreatedApiKey,
  type ManagementClient,
  WEBHOOK_TOPICS,
  type WebhookSummary,
  type WebhookTopic,
} from '../lib/management.js';
import { useInvalidate, useScopedQuery } from '../lib/queries.js';
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
          <TabsTrigger value="roles">Roles</TabsTrigger>
          <TabsTrigger value="webhooks">Webhooks</TabsTrigger>
          <TabsTrigger value="environments">Environments</TabsTrigger>
          <TabsTrigger value="ai-actions">AI Actions</TabsTrigger>
          <TabsTrigger value="functions">Functions</TabsTrigger>
          <TabsTrigger value="extensions">Extensions</TabsTrigger>
          <TabsTrigger value="audit-log">Audit log</TabsTrigger>
          <TabsTrigger value="connection">Connection</TabsTrigger>
        </TabsList>
        <TabsContent value="api-keys" className="mt-4">
          <ApiKeys client={client} />
        </TabsContent>
        <TabsContent value="roles" className="mt-4">
          <RolesSettings client={client} />
        </TabsContent>
        <TabsContent value="webhooks" className="mt-4">
          <Webhooks client={client} />
        </TabsContent>
        <TabsContent value="environments" className="mt-4">
          <Environments client={client} />
        </TabsContent>
        <TabsContent value="ai-actions" className="mt-4">
          <AiActions client={client} />
        </TabsContent>
        <TabsContent value="functions" className="mt-4">
          <Functions client={client} />
        </TabsContent>
        <TabsContent value="extensions" className="mt-4">
          <AppExtensions client={client} />
        </TabsContent>
        <TabsContent value="audit-log" className="mt-4">
          <AuditLog client={client} />
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
  const invalidate = useInvalidate();
  const [alias, setAlias] = useState('');
  const [pickedTarget, setPickedTarget] = useState('');
  const [busy, setBusy] = useState(false);

  const environments = useScopedQuery(['environments'], () => client.listEnvironments()).data ?? [];
  const aliases =
    useScopedQuery(['environment-aliases'], () => client.listEnvironmentAliases()).data ?? [];
  // Default the target picker to the first environment until the user chooses.
  const target = pickedTarget || environments[0]?.id || '';

  const reload = () => invalidate(['environments'], ['environment-aliases']);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await client.setEnvironmentAlias(alias.trim(), target);
      setAlias('');
      await reload();
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
      await reload();
      toast.success('Alias deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  const repoint = async (name: string, targetEnvironmentId: string) => {
    try {
      await client.setEnvironmentAlias(name, targetEnvironmentId);
      await reload();
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
              <Select value={target} onValueChange={setPickedTarget}>
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

      <BranchMerge client={client} environments={environments} />
    </div>
  );
}

/** Append-only audit trail of mutating API actions (governance; space:admin). */
function AuditLog(props: { client: ManagementClient }) {
  const { client } = props;
  const invalidate = useInvalidate();

  // The audit log grows on every mutation, so always revalidate on mount.
  const auditQuery = useScopedQuery(['audit-log'], () => client.listAuditLog({ limit: 200 }), {
    staleTime: 0,
  });
  const entries = auditQuery.data ?? [];
  const loading = auditQuery.isPending;
  // isFetching (not isPending) so the Refresh button also disables during
  // button-triggered refetches, not just the first load.
  const refreshing = auditQuery.isFetching;
  const load = () => void invalidate(['audit-log']);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-2">
        <div>
          <h2 className="font-heading font-medium text-base">Audit log</h2>
          <p className="text-muted-foreground text-sm">
            Every mutating API action in this space, newest first.
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={load} disabled={refreshing}>
          Refresh
        </Button>
      </CardHeader>
      <CardContent>
        {loading ? (
          <p className="text-muted-foreground text-sm">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground text-sm">No audit entries yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Target</TableHead>
                <TableHead className="w-16 text-right">Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="whitespace-nowrap text-muted-foreground text-xs">
                    {new Date(e.at).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{e.actor}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{e.action}</TableCell>
                  <TableCell className="font-mono text-muted-foreground text-xs">
                    {e.targetId ?? '—'}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{e.status}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const KEY_KINDS: { value: ApiKeyKind; label: string }[] = [
  { value: 'cda', label: 'CDA — Delivery (read published)' },
  { value: 'cpa', label: 'CPA — Preview (read drafts)' },
  { value: 'cma', label: 'CMA — Management (full author/publish)' },
];
const ROLE_NONE = '__none__';

function RolesSettings(props: { client: ManagementClient }) {
  const toast = useToast();
  const invalidate = useInvalidate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  const roles = useScopedQuery(['roles'], () => props.client.listRoles()).data ?? [];

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      await props.client.createRole({
        name: name.trim(),
        scopes: ['preview:read', 'content:write'],
        contentGrants: [{ contentTypeApiId: '*', actions: ['read', 'write'] }],
      });
      setName('');
      await invalidate(['roles']);
      toast.success('Role created');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      await props.client.deleteRole(id);
      await invalidate(['roles']);
      toast.success('Role deleted');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <h2 className="font-heading text-base font-medium">Roles</h2>
      </CardHeader>
      <CardContent className="space-y-4">
        <form className="flex flex-wrap items-center gap-2" onSubmit={create}>
          <Input
            className="w-64"
            placeholder="Role name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" disabled={busy}>
            Create role
          </Button>
        </form>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Scopes</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {roles.map((role) => (
              <TableRow key={role.id}>
                <TableCell>{role.name}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {role.scopes.join(', ')}
                </TableCell>
                <TableCell>
                  <Button type="button" variant="ghost" size="sm" onClick={() => remove(role.id)}>
                    Delete
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function ApiKeys(props: { client: ManagementClient }) {
  const { client } = props;
  const toast = useToast();
  const invalidate = useInvalidate();
  const [kind, setKind] = useState<ApiKeyKind>('cda');
  const [roleId, setRoleId] = useState<string>(ROLE_NONE);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // The raw token is shown exactly once, right after minting.
  const [minted, setMinted] = useState<CreatedApiKey>();

  const keys = useScopedQuery(['api-keys'], () => client.listApiKeys()).data ?? [];
  const roles = useScopedQuery(['roles'], () => client.listRoles()).data ?? [];

  const roleName = useMemo(() => {
    const byId = new Map(roles.map((r) => [r.id, r.name]));
    return (id?: string) => (id ? (byId.get(id) ?? id) : undefined);
  }, [roles]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const created = await client.createApiKey({
        kind,
        name: name.trim() || undefined,
        roleId: roleId === ROLE_NONE ? undefined : roleId,
      });
      setMinted(created);
      setName('');
      setRoleId(ROLE_NONE);
      await invalidate(['api-keys']);
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
      await invalidate(['api-keys']);
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
          <Select value={roleId} onValueChange={setRoleId}>
            <SelectTrigger className="w-[220px]">
              <SelectValue placeholder="Role (optional)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ROLE_NONE}>No custom role</SelectItem>
              {roles.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
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
              <TableHead>Role</TableHead>
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
                  {k.roleId ? roleName(k.roleId) : '—'}
                </TableCell>
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
                <TableCell colSpan={6} className="text-muted-foreground">
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
  const invalidate = useInvalidate();
  const [url, setUrl] = useState('');
  const [secret, setSecret] = useState('');
  const [topics, setTopics] = useState<WebhookTopic[]>(['*']);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<WebhookSummary | null>(null);
  const [deliveriesFor, setDeliveriesFor] = useState<WebhookSummary | null>(null);

  const hooks = useScopedQuery(['webhooks'], () => client.listWebhooks()).data ?? [];
  const reload = () => invalidate(['webhooks']);

  const toggleActive = async (h: WebhookSummary) => {
    try {
      await client.updateWebhook(h.id, { active: !h.active });
      await reload();
      toast.success(h.active ? 'Webhook paused' : 'Webhook resumed');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await client.deleteWebhook(id);
      await reload();
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
    await reload();
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
      await reload();
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

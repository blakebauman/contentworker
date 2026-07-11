import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Lock } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';
import { type PersistMode, type PrincipalInfo, createManagementClient } from '../lib/management.js';
import { useToast } from '../lib/toast.js';

/**
 * Gate screen shown when no valid bearer token is configured. Validates the
 * token against GET /auth/me before entering the app.
 */
export function ConnectPage() {
  const { conn, updateConn } = useClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl);
  const [token, setToken] = useState(conn.token);
  const [persistMode, setPersistMode] = useState<PersistMode>(conn.persistMode ?? 'session');
  const [busy, setBusy] = useState(false);
  const [identity, setIdentity] = useState<PrincipalInfo | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = token.trim();
    if (!trimmed) {
      toast.error('Enter a bearer token');
      return;
    }
    setBusy(true);
    try {
      const next = {
        baseUrl: baseUrl.trim(),
        token: trimmed,
        persistMode,
      };
      updateConn(next);
      const probeClient = createManagementClient({ ...conn, ...next });
      const me = await probeClient.getPrincipal();
      setIdentity(me);
      toast.success(
        me.kind === 'admin'
          ? 'Connected as admin (all spaces)'
          : `Connected as ${me.kind} for space ${me.spaceId}`,
      );
      navigate('/dashboard', { replace: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-svh items-center justify-center bg-background p-6">
      <Card className="w-full max-w-md">
        <form onSubmit={submit}>
          <CardHeader>
            <CardTitle>Connect to contentworker</CardTitle>
            <CardDescription>
              Sign in with a Management API bearer token (CMA key or admin token), or use SSO when
              configured. Credentials are stored in this browser only.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {import.meta.env.VITE_SSO_LOGIN_URL && (
              <Button type="button" variant="secondary" className="w-full" asChild>
                <a href={import.meta.env.VITE_SSO_LOGIN_URL}>Sign in with SSO</a>
              </Button>
            )}
            <div className="space-y-1.5">
              <Label htmlFor="connect-base-url">API base URL</Label>
              <Input
                id="connect-base-url"
                placeholder="Blank = same origin (recommended locally)"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="connect-token">Bearer token</Label>
              <Input
                id="connect-token"
                type="password"
                autoComplete="off"
                placeholder="cw_cma_… or admin token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="connect-persist">Remember token</Label>
              <Select value={persistMode} onValueChange={(v) => setPersistMode(v as PersistMode)}>
                <SelectTrigger id="connect-persist">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="session">This browser session only</SelectItem>
                  <SelectItem value="local">Until cleared (localStorage)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {identity && (
              <p className="text-sm text-muted-foreground">
                Last probe: {identity.kind}
                {identity.spaceId !== '*' ? ` · ${identity.spaceId}` : ' · all spaces'}
              </p>
            )}
          </CardContent>
          <CardFooter>
            <Button type="submit" className="w-full" disabled={busy}>
              <Lock className="size-4" />
              {busy ? 'Connecting…' : 'Connect'}
            </Button>
          </CardFooter>
        </form>
      </Card>
    </div>
  );
}

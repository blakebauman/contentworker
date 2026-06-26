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
import { AlertTriangle, Lock } from 'lucide-react';
import { useState } from 'react';
import { useClient } from '../../lib/client-context.js';
import { useToast } from '../../lib/toast.js';

/**
 * "Account Access" — manage the API credentials this console authenticates with
 * (base URL + bearer token), mirroring the shadcn account-access card. Writes
 * through the shared connection so changes re-wire the Management client at once.
 */
export function ConnectionAccessCard() {
  const { conn, updateConn } = useClient();
  const toast = useToast();
  const [baseUrl, setBaseUrl] = useState(conn.baseUrl);
  const [token, setToken] = useState(conn.token);

  const dirty = baseUrl !== conn.baseUrl || token !== conn.token;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    updateConn({ baseUrl: baseUrl.trim(), token: token.trim() });
    toast.success('Connection updated');
  };

  const clearCredentials = () => {
    setToken('');
    updateConn({ token: '' });
    toast.success('Stored credentials cleared');
  };

  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>Account Access</CardTitle>
          <CardDescription>Update the API credentials this console uses.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="cw-base-url">API base URL</Label>
            <Input
              id="cw-base-url"
              placeholder="https://api.contentworker.dev (blank = same origin)"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cw-token">Access token</Label>
            <Input
              id="cw-token"
              type="password"
              placeholder="bearer token"
              autoComplete="off"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </div>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-3">
          <Button type="submit" disabled={!dirty}>
            <Lock className="size-4" />
            Update Security
          </Button>

          {/* Danger Zone — local-only: forgets the stored bearer token. */}
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <AlertTriangle className="size-4 shrink-0" />
                Clear stored credentials
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear stored credentials?</AlertDialogTitle>
                <AlertDialogDescription>
                  This forgets the bearer token saved in this browser. The console will stop loading
                  data until you enter a token again. Nothing on the server is affected.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={clearCredentials}>Clear token</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </CardFooter>
      </form>
    </Card>
  );
}

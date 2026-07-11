import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useClient } from '../lib/client-context.js';

/** Redirects unauthenticated users to /connect before any app route loads. */
export function AuthGate() {
  const { conn, authReady, authenticated } = useClient();
  const location = useLocation();

  if (!authReady) {
    return (
      <div className="flex min-h-svh items-center justify-center text-muted-foreground">
        Checking connection…
      </div>
    );
  }

  if (!authenticated) {
    return <Navigate to="/connect" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

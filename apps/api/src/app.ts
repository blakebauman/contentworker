import type { AppContext, RagDeps } from '@cw/application';
import type { BlobStore } from '@cw/ports';
import { Hono } from 'hono';
import type { AuthDeps } from './auth.js';
import { sha256Hasher } from './auth.js';
import type { ApiConfig } from './config.js';
import { onError } from './http.js';
import { deliveryRoutes } from './routes/delivery.js';
import { managementRoutes } from './routes/management.js';
import { previewRoutes } from './routes/preview.js';

/**
 * Builds the HTTP app. The ROLE config gates which modules mount; every module
 * resolves a Principal from the bearer token and enforces RBAC scopes per route.
 */
export function createApp(ctx: AppContext, config: ApiConfig, rag: RagDeps, blob: BlobStore): Hono {
  const app = new Hono();
  app.onError(onError);

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => c.json({ status: 'ready', role: config.role }));

  const deps: AuthDeps = { ctx, hasher: sha256Hasher, adminToken: config.adminToken, rag, blob };

  const mountManagement = config.role === 'all' || config.role === 'management';
  const mountDelivery = config.role === 'all' || config.role === 'delivery';
  const mountPreview = config.role === 'all' || config.role === 'preview';

  if (mountManagement) app.route('/', managementRoutes(deps));
  if (mountDelivery) app.route('/', deliveryRoutes(deps));
  if (mountPreview) app.route('/', previewRoutes(deps));

  return app;
}

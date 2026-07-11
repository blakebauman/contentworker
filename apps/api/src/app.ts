import { InProcessAgentRuntime, makeActivities } from '@cw/agent-runtime';
import type { AppContext, RagDeps } from '@cw/application';
import type { AIProvider, BlobStore, EventBus } from '@cw/ports';
import { Hono } from 'hono';
import type { AuthDeps } from './auth.js';
import { createApiHasher } from './auth.js';
import type { ApiConfig } from './config.js';
import { onError } from './http.js';
import { oidcRoutes } from './oidc/routes.js';
import { deliveryRoutes } from './routes/delivery.js';
import { managementRoutes } from './routes/management.js';
import { previewRoutes } from './routes/preview.js';

/** A bus that never emits — the Live Content API then yields only keepalives. */
const noopBus: EventBus = {
  publish: async () => {},
  subscribe: () => ({ close: async () => {} }),
};

/**
 * Builds the HTTP app. The ROLE config gates which modules mount; every module
 * resolves a Principal from the bearer token and enforces RBAC scopes per route.
 */
export function createApp(
  ctx: AppContext,
  config: ApiConfig,
  rag: RagDeps,
  blob: BlobStore,
  ai: AIProvider,
  bus: EventBus = noopBus,
): Hono {
  const app = new Hono();
  app.onError(onError);

  app.get('/healthz', (c) => c.json({ status: 'ok' }));
  app.get('/readyz', (c) => c.json({ status: 'ready', role: config.role }));

  const deps: AuthDeps = {
    ctx,
    hasher: createApiHasher(config.tokenPepper),
    adminToken: config.adminToken,
    sessionSecret: config.sessionSecret,
    rag,
    blob,
    ai,
    bus,
    // On-demand agent actions are synchronous request/response, so they always
    // run in-process; the durable Temporal path serves the worker's
    // on-publish runs (AGENT_RUNTIME=temporal).
    agents: new InProcessAgentRuntime(makeActivities({ ctx, ai })),
  };

  const mountManagement = config.role === 'all' || config.role === 'management';
  const mountDelivery = config.role === 'all' || config.role === 'delivery';
  const mountPreview = config.role === 'all' || config.role === 'preview';

  if (mountManagement) {
    app.route('/', oidcRoutes(deps, config));
    app.route('/', managementRoutes(deps));
  }
  if (mountDelivery) app.route('/', deliveryRoutes(deps));
  if (mountPreview) app.route('/', previewRoutes(deps));

  return app;
}

import { createServer } from 'node:http';
import {
  logger,
  metricsText,
  startDefaultMetrics,
  startTelemetry,
  stopTelemetry,
} from '@cw/telemetry';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { validateApiSecrets } from './secure-secrets.js';
import { seedDev } from './seed.js';
import { wire } from './wire.js';

startTelemetry('cw-api');
startDefaultMetrics('cw-api');

const config = loadConfig();
validateApiSecrets(config);
const wired = wire(config);
const { ctx, rag, blob, ai, bus, rateLimiter } = wired;

// Bootstrap dev data (space + keys + demo content) when SEED_DEV is set — the
// in-memory store already seeds, so this matters for a real database.
if (config.seedDev) {
  await seedDev(ctx, config).catch((err) => {
    logger.error({ err }, 'seed: failed');
    process.exit(1);
  });
}

const app = createApp(ctx, config, rag, blob, ai, bus, rateLimiter, wired.signalReview);

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  const backend = config.databaseUrl ? 'postgres' : 'in-memory store';
  logger.info({ role: config.role, port: info.port, backend }, 'contentworker api listening');
});

// Prometheus /metrics on a separate, unexposed port — never on the API port,
// where the default ingress (path /) would publish process internals to the
// internet. prom-client is Node-only; the edge Worker uses Cloudflare's own
// observability instead.
const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 9464);
const metricsServer = createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
    res.end(await metricsText());
    return;
  }
  res.writeHead(404).end();
});
metricsServer.listen(HEALTH_PORT, () =>
  logger.info({ port: HEALTH_PORT }, 'api metrics listening'),
);

// Graceful shutdown: stop accepting connections, let in-flight requests
// finish, then release Redis/Postgres so pod rotation never drops requests.
let shuttingDown = false;
const shutdown = (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'api shutting down');
  metricsServer.close();
  server.close(async () => {
    try {
      await wired.close();
      await stopTelemetry();
    } catch (err) {
      logger.error({ err }, 'shutdown cleanup error');
    }
    process.exit(0);
  });
  // Backstop: if keep-alive connections hold close() open, exit anyway.
  setTimeout(() => process.exit(0), 15_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

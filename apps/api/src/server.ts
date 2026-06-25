import { serve } from '@hono/node-server';
import { logger, startTelemetry } from '@cw/telemetry';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { wire } from './wire.js';

startTelemetry('cw-api');

const config = loadConfig();
const { ctx, rag, blob } = wire(config);
const app = createApp(ctx, config, rag, blob);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const backend = config.databaseUrl ? 'postgres' : 'in-memory store';
  logger.info({ role: config.role, port: info.port, backend }, 'contentworker api listening');
});

import { logger, startTelemetry } from '@cw/telemetry';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { seedDev } from './seed.js';
import { wire } from './wire.js';

startTelemetry('cw-api');

const config = loadConfig();
const { ctx, rag, blob, ai } = wire(config);

// Bootstrap dev data (space + keys + demo content) when SEED_DEV is set — the
// in-memory store already seeds, so this matters for a real database.
if (config.seedDev) {
  await seedDev(ctx, config).catch((err) => {
    logger.error({ err }, 'seed: failed');
    process.exit(1);
  });
}

const app = createApp(ctx, config, rag, blob, ai);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  const backend = config.databaseUrl ? 'postgres' : 'in-memory store';
  logger.info({ role: config.role, port: info.port, backend }, 'contentworker api listening');
});

import { serve } from '@hono/node-server';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { wire } from './wire.js';

const config = loadConfig();
const { ctx, rag, blob } = wire(config);
const app = createApp(ctx, config, rag, blob);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  // eslint-disable-next-line no-console
  const backend = config.databaseUrl ? 'postgres' : 'in-memory store';
  console.log(
    `contentworker api [role=${config.role}] listening on http://localhost:${info.port} (${backend})`,
  );
});

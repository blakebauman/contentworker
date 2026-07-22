import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { AGENT_TASK_QUEUE } from '@cw/agent-runtime/temporal';
import { logger, metricsText, startDefaultMetrics, startTelemetry } from '@cw/telemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import { wireActivities } from './wire.js';

startTelemetry('cw-agent-worker');
startDefaultMetrics('cw-agent-worker');

const HEALTH_PORT = Number(process.env.HEALTH_PORT ?? 9464);

/**
 * Temporal worker: hosts the agent workflows + activities on the agent task
 * queue. Connects to the Temporal frontend (TEMPORAL_ADDRESS, default
 * localhost:7233). Run alongside a self-hosted Temporal cluster on K8s.
 */
async function main() {
  const { activities } = wireActivities();
  const address = process.env.TEMPORAL_ADDRESS ?? 'localhost:7233';
  const connection = await NativeConnection.connect({ address });

  const worker = await Worker.create({
    connection,
    namespace: process.env.TEMPORAL_NAMESPACE ?? 'default',
    taskQueue: AGENT_TASK_QUEUE,
    workflowsPath: fileURLToPath(new URL('./workflows.ts', import.meta.url)),
    activities,
  });

  // Health (K8s liveness) + metrics: healthy while the worker polls Temporal.
  const health = createServer(async (req, res) => {
    if (req.url === '/healthz' || req.url === '/readyz') {
      const state = worker.getState();
      const ok = state === 'RUNNING' || state === 'INITIALIZED';
      res.writeHead(ok ? 200 : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: state }));
      return;
    }
    if (req.url === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
      res.end(await metricsText());
      return;
    }
    res.writeHead(404).end();
  });
  health.listen(HEALTH_PORT, () =>
    logger.info({ port: HEALTH_PORT }, 'agent-worker health listening'),
  );

  // Graceful shutdown: worker.shutdown() drains in-flight activities, then
  // run() resolves. (The Temporal Runtime also installs default signal
  // handlers; ours makes the drain explicit and closes the health server.)
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'agent-worker shutting down');
    health.close();
    try {
      worker.shutdown();
    } catch {
      // already shutting down
    }
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  logger.info({ taskQueue: AGENT_TASK_QUEUE, temporal: address }, 'agent-worker running');
  await worker.run();
  health.close();
}

main().catch((err) => {
  logger.error({ err }, 'agent-worker failed');
  process.exit(1);
});

import { fileURLToPath } from 'node:url';
import { AGENT_TASK_QUEUE } from '@cw/agent-runtime/temporal';
import { logger, startTelemetry } from '@cw/telemetry';
import { NativeConnection, Worker } from '@temporalio/worker';
import { wireActivities } from './wire.js';

startTelemetry('cw-agent-worker');

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

  logger.info({ taskQueue: AGENT_TASK_QUEUE, temporal: address }, 'agent-worker running');
  await worker.run();
}

main().catch((err) => {
  logger.error({ err }, 'agent-worker failed');
  process.exit(1);
});

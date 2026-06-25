/**
 * Temporal workflow definitions. These run in Temporal's deterministic sandbox,
 * so this module imports ONLY workflow-safe code: the pure `enrichWorkflow` /
 * `moderateWorkflow` orchestration (no I/O) plus `proxyActivities`. The real
 * side effects live in activities (registered with the worker) and are reached
 * through the proxy — which satisfies the same `Activities` interface the
 * in-process runtime uses, so the workflow logic is shared, not duplicated.
 */
import { enrichWorkflow, moderateWorkflow } from '@cw/agent-runtime/workflows';
import type { Activities, AgentRunResult, WorkflowInput } from '@cw/agent-runtime';
import { proxyActivities } from '@temporalio/workflow';

const activities = proxyActivities<Activities>({
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

export async function enrich(input: WorkflowInput): Promise<AgentRunResult> {
  return enrichWorkflow(activities, input);
}

export async function moderate(input: WorkflowInput): Promise<AgentRunResult> {
  return moderateWorkflow(activities, input);
}

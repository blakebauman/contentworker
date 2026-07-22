import type {
  Activities,
  AgentRunResult,
  DurableWaits,
  ReviewWatchInput,
  WorkflowInput,
} from '@cw/agent-runtime';
/**
 * Temporal workflow definitions. These run in Temporal's deterministic sandbox,
 * so this module imports ONLY workflow-safe code: the pure `enrichWorkflow` /
 * `moderateWorkflow` orchestration (no I/O) plus `proxyActivities`. The real
 * side effects live in activities (registered with the worker) and are reached
 * through the proxy — which satisfies the same `Activities` interface the
 * in-process runtime uses, so the workflow logic is shared, not duplicated.
 */
import {
  curateWorkflow,
  enrichWorkflow,
  moderateWorkflow,
  repurposeWorkflow,
  reviewWorkflow,
} from '@cw/agent-runtime/workflows';
import { condition, defineSignal, proxyActivities, setHandler } from '@temporalio/workflow';

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

export async function curate(input: WorkflowInput): Promise<AgentRunResult> {
  return curateWorkflow(activities, input);
}

export async function repurpose(input: WorkflowInput): Promise<AgentRunResult> {
  return repurposeWorkflow(activities, input);
}

// HITL: the detached review watcher. A human decision arrives as a Temporal
// Signal; `condition` waits durably (days) with a timeout, and the shared
// reviewWorkflow settles the outcome through activities.
export const reviewDecisionSignal = defineSignal<['approved' | 'rejected']>('review-decision');

export async function review(input: ReviewWatchInput): Promise<AgentRunResult> {
  let decision: 'approved' | 'rejected' | undefined;
  setHandler(reviewDecisionSignal, (d) => {
    decision = d;
  });
  const waits: DurableWaits = {
    awaitReviewDecision: async (_reviewId, timeoutMs) => {
      await condition(() => decision !== undefined, timeoutMs);
      return decision ?? null;
    },
  };
  return reviewWorkflow(activities, input, waits);
}

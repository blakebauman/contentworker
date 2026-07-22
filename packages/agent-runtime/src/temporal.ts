import type { IdGenerator } from '@cw/ports';
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/client';
import type { Client } from '@temporalio/client';
import { REVIEW_DECISION_SIGNAL as SIGNAL, reviewWorkflowId as wfId } from './types.js';
import type {
  AgentRunResult,
  AgentRuntime,
  ReviewWatchInput,
  WorkflowInput,
  WorkflowName,
} from './types.js';

/** The task queue the agent workflows + activities are hosted on. */
export const AGENT_TASK_QUEUE = 'contentworker-agents';

export { REVIEW_DECISION_SIGNAL, reviewWorkflowId } from './types.js';

/**
 * Durable `AgentRuntime` backed by Temporal. Starts a workflow and awaits its
 * result; because it implements the same `AgentRuntime` interface as
 * `InProcessAgentRuntime`, callers (e.g. the worker's enrich-on-publish hook)
 * swap executors with no logic change. Survives crashes via Temporal's
 * deterministic replay. Exported as the `@cw/agent-runtime/temporal` subpath so
 * consumers of the main entry never load `@temporalio/client`.
 */
export class TemporalAgentRuntime implements AgentRuntime {
  constructor(
    private readonly client: Client,
    private readonly taskQueue: string,
    private readonly ids: IdGenerator,
  ) {}

  async run(workflow: WorkflowName, input: WorkflowInput): Promise<AgentRunResult> {
    const handle = await this.client.workflow.start(workflow, {
      taskQueue: this.taskQueue,
      workflowId: `agent-${workflow}-${input.entryId}-${this.ids.newId()}`,
      args: [input],
    });
    return handle.result();
  }

  /** Fire-and-forget start of the durable review watcher (idempotent id). */
  async watchReview(input: ReviewWatchInput): Promise<void> {
    await this.client.workflow
      .start('review', {
        taskQueue: this.taskQueue,
        workflowId: wfId(input.reviewId),
        args: [input],
      })
      .catch((err) => {
        // An already-started watcher (duplicate delivery) is fine.
        if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      });
  }

  /** Delivers a decision to the watcher; false when it is no longer running. */
  async signalReviewDecision(
    reviewId: string,
    decision: 'approved' | 'rejected',
  ): Promise<boolean> {
    try {
      await this.client.workflow.getHandle(wfId(reviewId)).signal(SIGNAL, decision);
      return true;
    } catch {
      return false;
    }
  }
}

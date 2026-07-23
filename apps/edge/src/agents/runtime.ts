import type {
  AgentRunResult,
  AgentRuntime,
  PublishRunsInput,
  ReviewWatchInput,
  WorkflowInput,
  WorkflowName,
} from '@cw/agent-runtime';
import type { IdGenerator } from '@cw/ports';

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 10 * 60_000;

/** Parameters passed to the AgentWorkflow entrypoint (see agents/workflow.ts). */
export type AgentWfParams =
  | { readonly workflow: Exclude<WorkflowName, 'review'>; readonly input: WorkflowInput }
  | { readonly workflow: 'review'; readonly input: ReviewWatchInput }
  | { readonly workflow: 'publish_agents'; readonly input: PublishRunsInput };

/** Event type delivering a human review decision to the watcher instance. */
export const REVIEW_DECISION_EVENT = 'review-decision';

/** Deterministic watcher instance id — decision senders derive it too. */
export const reviewInstanceId = (reviewId: string) => `review-${reviewId}`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * AgentRuntime on Cloudflare Workflows — the durable sibling of
 * InProcessAgentRuntime/TemporalAgentRuntime. `run` starts one AgentWorkflow
 * instance and polls its status until it completes (Workflows has no blocking
 * result API). Callers run inside a queue consumer, where waiting is fine; a
 * consumer retry after instance creation starts a duplicate run, which is
 * benign — runs are recorded proposals, never direct state changes.
 */
export class CloudflareWorkflowsAgentRuntime implements AgentRuntime {
  constructor(
    private readonly wf: Workflow,
    private readonly ids: IdGenerator,
  ) {}

  async run(workflow: WorkflowName, input: WorkflowInput): Promise<AgentRunResult> {
    if (workflow === 'review') throw new Error('start the review watcher via watchReview');
    const params: AgentWfParams = { workflow, input };
    const instance = await this.wf.create({
      id: `agent-${workflow}-${this.ids.newId()}`,
      params,
    });
    const deadline = Date.now() + MAX_WAIT_MS;
    for (;;) {
      const status = await instance.status();
      if (status.status === 'complete') return status.output as AgentRunResult;
      if (status.status === 'errored' || status.status === 'terminated') {
        const cause =
          typeof status.error === 'object' && status.error !== null && 'message' in status.error
            ? String((status.error as { message: unknown }).message)
            : String(status.error ?? '');
        throw new Error(`agent workflow ${workflow} ${status.status}: ${cause}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`agent workflow ${workflow} did not complete within ${MAX_WAIT_MS}ms`);
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  /**
   * Fire-and-forget start of the on-publish agent pass for a chunk of entries.
   *
   * Deliberately does NOT poll: the run records its own outcome (see
   * publishAgentsWorkflow), so this returns as soon as the instance exists.
   * `run()` above still polls, but only serves low-volume interactive actions
   * whose caller genuinely needs the result in the response.
   */
  async startPublishRuns(input: PublishRunsInput): Promise<void> {
    const params: AgentWfParams = { workflow: 'publish_agents', input };
    await this.wf.create({ id: `publish-agents-${this.ids.newId()}`, params });
  }

  /** Fire-and-forget start of the durable review watcher (idempotent id). */
  async watchReview(input: ReviewWatchInput): Promise<void> {
    await this.wf
      .create({ id: reviewInstanceId(input.reviewId), params: { workflow: 'review', input } })
      .catch((err) => {
        // An already-started watcher (duplicate delivery) is fine.
        if (!String(err).includes('already') && !String(err).includes('exists')) throw err;
      });
  }
}

/** Delivers a decision to a watcher instance; false when it is gone/closed. */
export async function sendReviewDecision(
  wf: Workflow,
  reviewId: string,
  decision: 'approved' | 'rejected',
): Promise<boolean> {
  try {
    const instance = await wf.get(reviewInstanceId(reviewId));
    await instance.sendEvent({ type: REVIEW_DECISION_EVENT, payload: decision });
    return true;
  } catch {
    return false;
  }
}

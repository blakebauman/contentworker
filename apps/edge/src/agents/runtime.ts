import type { AgentRunResult, AgentRuntime, WorkflowInput, WorkflowName } from '@cw/agent-runtime';
import type { IdGenerator } from '@cw/ports';

const POLL_INTERVAL_MS = 2_000;
const MAX_WAIT_MS = 10 * 60_000;

/** Parameters passed to the AgentWorkflow entrypoint (see agents/workflow.ts). */
export interface AgentWfParams {
  readonly workflow: WorkflowName;
  readonly input: WorkflowInput;
}

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
}

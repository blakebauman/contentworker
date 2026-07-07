import type { IdGenerator } from '@cw/ports';
import type { Client } from '@temporalio/client';
import type { AgentRunResult, AgentRuntime, WorkflowInput, WorkflowName } from './types.js';

/** The task queue the agent workflows + activities are hosted on. */
export const AGENT_TASK_QUEUE = 'contentworker-agents';

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
}

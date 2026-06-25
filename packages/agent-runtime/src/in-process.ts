import type {
  Activities,
  AgentRunResult,
  AgentRuntime,
  WorkflowInput,
  WorkflowName,
} from './types.js';
import { enrichWorkflow, moderateWorkflow } from './workflows.js';

/**
 * Runs workflows directly in the calling process — the default executor for dev,
 * tests, and single-node deployments. It is NOT durable (no replay across
 * crashes); for durability the same workflows run under Temporal via a
 * `TemporalAgentRuntime` that implements this identical `AgentRuntime` interface
 * (each `Activities` method becomes a Temporal Activity). See temporal.md.
 */
export class InProcessAgentRuntime implements AgentRuntime {
  constructor(private readonly activities: Activities) {}

  async run(workflow: WorkflowName, input: WorkflowInput): Promise<AgentRunResult> {
    switch (workflow) {
      case 'enrich':
        return enrichWorkflow(this.activities, input);
      case 'moderate':
        return moderateWorkflow(this.activities, input);
    }
  }
}

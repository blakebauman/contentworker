# Temporal executor (production durability)

The workflows in `src/workflows.ts` are written as pure orchestration over the
`Activities` interface, so they map directly onto Temporal with **no changes to
the workflow logic** — only a different `AgentRuntime` implementation:

- **`AgentRuntime.run(workflow, input)`** → `client.workflow.start(workflow, { taskQueue, args: [input], workflowId })`
  (a `TemporalAgentRuntime` wrapping `@temporalio/client`).
- **Each `Activities` method** → a Temporal **Activity** (registered with the
  worker from `makeActivities(...)`). Activities are the only side-effect site,
  exactly as Temporal requires; the workflow stays deterministic.
- **Worker** (`@temporalio/worker`): registers the workflow bundle + activities
  on a task queue.
- **HITL**: the enrich `needs_review` branch becomes a Temporal **Signal** the
  workflow awaits (`condition(() => approved)`); the Management API sends the
  signal when a human approves.
- **Scheduling** (curate/repurpose): Temporal **Schedules** per space.
- **Durability**: deterministic replay survives crashes; `InProcessAgentRuntime`
  does not (it's for dev/tests/single-node).

Self-hosted on K8s via the official Temporal Helm chart against the platform's
own Postgres — no proprietary serverless, consistent with the cloud-agnostic goal.

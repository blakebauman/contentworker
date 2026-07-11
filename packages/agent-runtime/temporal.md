# Temporal executor (production durability)

The workflows in `src/workflows.ts` are written as pure orchestration over the
`Activities` interface, so they map directly onto Temporal with **no changes to
the workflow logic** — only a different `AgentRuntime` implementation:

- **`AgentRuntime.run(workflow, input)`** → `client.workflow.start(workflow, { taskQueue, args: [input], workflowId })`
  (`TemporalAgentRuntime`, exported from the `@cw/agent-runtime/temporal` subpath so main-entry
  consumers never load `@temporalio/client`). `apps/worker` selects it with `AGENT_RUNTIME=temporal`
  (`TEMPORAL_ADDRESS`/`TEMPORAL_NAMESPACE`/`TEMPORAL_TASK_QUEUE`); default stays in-process.
- **Each `Activities` method** → a Temporal **Activity** (registered with the
  worker from `makeActivities(...)`). Activities are the only side-effect site,
  exactly as Temporal requires; the workflow stays deterministic.
- **Worker** (`@temporalio/worker`): `apps/agent-worker` registers the workflow bundle
  (enrich/moderate/curate/repurpose) + activities on the `contentworker-agents` task queue.
  The Helm chart deploys it automatically when `agents.runtime=temporal`, and can bundle a
  self-hosted Temporal cluster (`temporal.enabled=true`, official subchart, persistence on
  the platform Postgres).
- **HITL** (future): the enrich `needs_review` branch becomes a Temporal **Signal** the
  workflow awaits (`condition(() => approved)`); the Management API sends the
  signal when a human approves.
- **Scheduling** (future): periodic curate/repurpose runs via Temporal **Schedules** per space.
- **Durability**: deterministic replay survives crashes; `InProcessAgentRuntime`
  does not (it's for dev/tests/single-node).

Self-hosted on K8s via the official Temporal Helm chart against the platform's
own Postgres — no proprietary serverless, consistent with the cloud-agnostic goal.

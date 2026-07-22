# Deployment

contentworker ships as a **single container image** that runs any of the services (api, worker,
mcp-server, migrator). The service and its adapters are selected entirely by environment
variables, so the same image runs on any cloud — see [Configuration](./configuration.md).

For what to back up and how to restore per target, see
[Backup & restore](./backup-and-restore.md); for the per-target consistency
matrix, see [Consistency & guarantees](./consistency.md).

## Container image

The `Dockerfile` builds one image for all Node services, in two stages:

- Base `node:22-alpine`, `corepack enable` for pnpm.
- **`prod` (default)** — production dependencies only and runs as the non-root
  `node` user. `tsx` is a production dependency of each app (services run TS
  directly, no compile step), while build/test toolchains (typescript, vite,
  vitest, drizzle-kit, biome) never reach the runtime image. This is what the
  Helm chart deploys.
- **`dev`** — full install including dev dependencies; docker-compose's `admin`
  service targets it to build/serve the SPA with vite inside the container.
- Default command runs the API; each service overrides the command:
  - api: `pnpm --filter @cw/api start`
  - worker: `pnpm --filter @cw/worker start`
  - agent-worker: `pnpm --filter @cw/agent-worker start` (needs `TEMPORAL_ADDRESS`)
  - mcp-server: `pnpm --filter @cw/mcp-server start`
  - migrator: `pnpm --filter @cw/migrator start`

## Local: docker-compose

`docker compose up --build` brings up the full stack. Compose **auto-merges**
`docker-compose.yml` with `docker-compose.override.yml` (no `-f` flags needed).

| Service | Image / command | Notes |
| --- | --- | --- |
| `postgres` | `pgvector/pgvector:pg16` | port 5432, healthchecked; `vector` extension available for semantic search |
| `redis` | `redis:7-alpine` | port 6379, healthchecked |
| `migrator` | `@cw/migrator` | one-shot; applies Drizzle migrations before api/worker |
| `api` | `@cw/api`, `ROLE=all` | http://localhost:8787 |
| `admin` | `@cw/admin` | http://localhost:5173 — see [Admin UI](./admin-ui.md) |
| `worker` | `@cw/worker` | outbox relay + dispatch |

Shared env: `DATABASE_URL=postgres://postgres:postgres@postgres:5432/contentworker`,
`REDIS_URL=redis://redis:6379`. The API also sets `SEED_DEV=true` and
`SEED_LOCALES=en-US,de-DE` so a fresh Postgres stack is usable immediately (idempotent
bootstrap of space, dev keys, and demo content). Dev keys: `dev-cma-key`, `dev-cda-key`,
`dev-cpa-key`, `dev-admin-token`.

Optional AI: set `ANTHROPIC_API_KEY` in a `.env` file (compose reads it for the `api`
service). Without it, generation endpoints return dev stubs.

### Admin service: base vs override

`docker-compose.yml` defines the `admin` service as a **prod-style** build:
`pnpm --filter @cw/admin build && vite preview` (serves the built SPA, proxies API paths to
`api`).

`docker-compose.override.yml` overrides **only** `admin` for local dev:

- Runs the Vite **dev server** with hot-module reload instead of `build && preview`.
- Bind-mounts `./apps/admin` and `./packages` so edits on the host reload live.
- Uses anonymous volumes for `node_modules` so macOS host binaries never leak into the Linux
  container.
- Sets `VITE_USE_POLLING=true` so HMR works across the bind mount.

To run the prod-style preview instead, use `docker compose -f docker-compose.yml up` or
rename/remove the override file.

Run the admin outside Docker with `pnpm --filter @cw/admin dev` (see
[Admin UI](./admin-ui.md)).

Compose sets `EMBEDDINGS_PROVIDER=local` on api/worker (via shared `x-app-env`) so publish-time
RAG indexing and hybrid search work out of the box, matching `values-local.yaml`.

## Kubernetes: Helm

The chart at `infra/helm/contentworker/` is cloud-agnostic; per-cloud `values-*.yaml` files
supply only what differs.

### Workloads

| Workload | Kind | Role |
| --- | --- | --- |
| api | Deployment + Service + HPA | The HTTP API; `ROLE`-gated |
| worker | Deployment (+ optional HPA) | Outbox relay, dispatch, optional enrich agent |
| agent-worker | Deployment (conditional) | Temporal workflow host — only when `agents.runtime=temporal` |
| mcp-server | Deployment + Service | MCP tool surface |
| migrator | Job (pre-install/upgrade hook) | Runs migrations before app pods start |
| postgres / redis | StatefulSet / Deployment | **bundled for local only**; managed services in cloud |

### Worker autoscaling: CPU HPA or KEDA queue depth

The worker ships with an optional CPU HPA (`worker.autoscaling`), but CPU is a
poor proxy for its real load — the BullMQ backlog is. With
[KEDA](https://keda.sh) installed in the cluster, `worker.keda.enabled: true`
renders a `ScaledObject` that scales the worker Deployment on the events
wait-list length (`bull:cw.events:wait`, threshold `worker.keda.listLength`
jobs per replica, between `minReplicas` and `maxReplicas`). Set
`worker.keda.redisAddress` (host:port — KEDA cannot parse `REDIS_URL`) and,
for AUTH-enabled Redis, point `worker.keda.passwordSecretKey` at the password
key in the platform secret (rendered as a `TriggerAuthentication`). While KEDA
is enabled the chart suppresses the worker's CPU HPA so the two controllers
never fight over replicas.

### Monolith vs. split API

- **Monolith** (`api.split.enabled: false`, default): one `api` Deployment with `ROLE=all`.
- **Split** (`api.split.enabled: true`): three Deployments — `api-management`, `api-delivery`,
  `api-preview` — each with its own `ROLE`, replica count, and HPA. Delivery is read-heavy and
  scales highest; preview lowest. This is the recommended production topology.

### Base values (excerpt)

```yaml
image: { repository: contentworker, tag: "0.1.0" }
config:
  aiProvider: anthropic           # or azure-openai
  embeddingsProvider: local       # or azure-openai, or "" to disable
  embeddingsDim: "1536"
  seedSpaceId: space-1
  seedDefaultLocale: en-US
secrets:
  create: true                    # local only; false in cloud (use existingSecret)
  existingSecret: ""              # point at an External-Secrets-synced Secret in cloud
api:      { replicas: 2, role: all, port: 8787, split: { enabled: false },
           autoscaling: { enabled: true, minReplicas: 2, maxReplicas: 10 } }
worker:   { replicas: 1 }
mcpServer:{ enabled: true, replicas: 2, port: 8788 }
migrator: { enabled: true }
postgres: { bundled: false }
redis:    { bundled: false }
agents:
  enrich: false
  moderate: false
  autoApply: false
  runtime: in-process   # or temporal (deploys agent-worker + wires AGENT_RUNTIME)
temporal:
  enabled: false        # optional bundled Temporal subchart for local/kind
```

The admin SPA is **compose-only** today (no Helm workload). OIDC SSO is configured on the **API**
(`OIDC_*`, `SESSION_SECRET`, `ADMIN_UI_URL`). Production admin UIs would be hosted separately
(e.g. static assets behind ingress) and pointed at the
Management API.

### Agents & Temporal

On-publish agents (`enrich`, `moderate`) are controlled by Helm `agents.*` values, which map
to `AGENTS_ENRICH`, `AGENTS_MODERATE`, `AGENTS_AUTO_APPLY`, and optionally `AGENT_RUNTIME`
in the ConfigMap.

| `agents.runtime` | Behavior |
| --- | --- |
| `in-process` (default) | Worker runs agents in-process via `InProcessAgentRuntime` (non-durable) |
| `temporal` | Worker starts workflows on Temporal; `agent-worker` Deployment hosts workflow + activity code on the `contentworker-agents` task queue |

When `agents.runtime=temporal`, set `agents.temporal.address` to an existing Temporal cluster
(or enable the bundled `temporal` subchart for local/kind with `temporal.enabled: true`). The
`agent-worker` Deployment is rendered only in temporal mode.

### Per-cloud values

| File | Target | Key choices |
| --- | --- | --- |
| `values-local.yaml` | kind / minikube | `pullPolicy: Never`, `postgres.bundled: true`, `redis.bundled: true`, local embeddings, single replica, secrets created in-cluster |
| `values-aws.yaml` | EKS + RDS + ElastiCache | ECR image, **IRSA** (`eks.amazonaws.com/role-arn`), `existingSecret` via External Secrets, ALB ingress, split API, HPA up to 20 |
| `values-gcp.yaml` | GKE + Cloud SQL + Memorystore | Artifact Registry image, **GKE Workload Identity** (`iam.gke.io/gcp-service-account`), GCE ingress, split API |
| `values-azure.yaml` | AKS + Azure DB for PostgreSQL + Azure Cache | ACR image, **Azure Workload Identity**, Azure OpenAI for both chat and embeddings (deployment names in `config.extraEnv`), web-app-routing ingress, split API |

Install, e.g.:

```bash
helm upgrade --install cw infra/helm/contentworker \
  -f infra/helm/contentworker/values-aws.yaml \
  --namespace contentworker --create-namespace
```

### Secrets

In cloud, set `secrets.create: false` and `secrets.existingSecret: <name>`, and sync the secret
from your secret manager (e.g. External Secrets Operator) so `DATABASE_URL`, `REDIS_URL`,
`ADMIN_TOKEN`, `MCP_TOKEN`, and the AI provider keys are injected without living in values files.
Cloud identity is wired via the service account annotation (IRSA / GKE WI / Azure WI), so pods
authenticate to managed databases and secret stores without static credentials.

## Migrations

The migrator runs `drizzle-kit migrate` against `DATABASE_URL` using the committed SQL under
`packages/adapters/store-postgres/drizzle/`. Run it as a one-shot before serving traffic
(compose dependency, or the Helm pre-install/upgrade Job). After editing the Drizzle schema
(`schema.ts`), regenerate SQL with `pnpm --filter @cw/adapter-store-postgres generate` and commit
the result — never hand-edit generated SQL.

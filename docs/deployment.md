# Deployment

contentworker ships as a **single container image** that runs any of the services (api, worker,
mcp-server, migrator). The service and its adapters are selected entirely by environment
variables, so the same image runs on any cloud — see [Configuration](./configuration.md).

## Container image

The `Dockerfile` builds one image for all Node services:

- Base `node:22-alpine`, `corepack enable` for pnpm.
- Copies the workspace and runs `pnpm install` (dev deps included — services run via `tsx`, so
  there's no separate compile step).
- Default command runs the API; each service overrides the command:
  - api: `pnpm --filter @cw/api start`
  - worker: `pnpm --filter @cw/worker start`
  - agent-worker: `pnpm --filter @cw/agent-worker start` (needs `TEMPORAL_ADDRESS`)
  - mcp-server: `pnpm --filter @cw/mcp-server start`
  - migrator: `pnpm --filter @cw/migrator start`

## Local: docker-compose

`docker compose up --build` brings up the full stack:

| Service | Image / command | Notes |
| --- | --- | --- |
| `postgres` | `postgres:16-alpine` | port 5432, healthchecked |
| `redis` | `redis:7-alpine` | port 6379, healthchecked |
| `migrator` | `@cw/migrator` | one-shot; applies Drizzle migrations before api/worker |
| `api` | `@cw/api`, `ROLE=all` | http://localhost:8787 |
| `worker` | `@cw/worker` | outbox relay + dispatch |

Shared env: `DATABASE_URL=postgres://postgres:postgres@postgres:5432/contentworker`,
`REDIS_URL=redis://redis:6379`. Dev keys: `dev-cma-key`, `dev-cda-key`, `dev-cpa-key`,
`dev-admin-token`.

## Kubernetes: Helm

The chart at `infra/helm/contentworker/` is cloud-agnostic; per-cloud `values-*.yaml` files
supply only what differs.

### Workloads

| Workload | Kind | Role |
| --- | --- | --- |
| api | Deployment + Service + HPA | The HTTP API; `ROLE`-gated |
| worker | Deployment (+ optional HPA) | Outbox relay, dispatch, optional enrich agent |
| agent-worker | Deployment | Temporal worker for durable enrich/moderate workflows (needs a Temporal cluster) |
| mcp-server | Deployment + Service | MCP tool surface |
| migrator | Job (pre-install/upgrade hook) | Runs migrations before app pods start |
| postgres / redis | StatefulSet / Deployment | **bundled for local only**; managed services in cloud |

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
```

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

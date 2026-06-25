# contentworker Helm chart

Cloud-agnostic Kubernetes deployment. **The same container image runs on every
cloud** — only the config and secret *source* differ per `values-<cloud>.yaml`.
That's the payoff of the ports-&-adapters core: provider selection is a value,
not a code change.

## Workloads

| Workload | Kind | Notes |
|---|---|---|
| `api` | Deployment(s) + Service + HPA | `ROLE`-gated. One Deployment (`role=all`) by default; `api.split.enabled=true` runs management/delivery/preview as three independently-scaled Deployments (the read-heavy Delivery module scales highest). |
| `worker` | Deployment + HPA | outbox relay, signed webhooks, cache invalidation, RAG embedding. |
| `mcp` | Deployment + Service | MCP agent tool surface. |
| `migrator` | Job (pre-install/upgrade hook) | applies Drizzle migrations before pods roll. |
| `postgres` / `redis` | StatefulSet / Deployment | **local only** (`*.bundled=true`); external/managed in cloud. |

## Datastores & secrets

Postgres and Redis are **external (managed)** in cloud — point `DATABASE_URL` /
`REDIS_URL` at RDS/Cloud SQL/Azure DB and ElastiCache/Memorystore/Azure Cache via
the secret. For local dev, `values-local.yaml` bundles both.

Secrets: in cloud set `secrets.create=false` and `secrets.existingSecret=...`,
populated by **External Secrets Operator** from the cloud's secret manager (AWS
Secrets Manager / GCP Secret Manager / Azure Key Vault). The chart-created Secret
(`secrets.create=true`) is for local/dev only.

## Deploy

```bash
# Build the image (one image, all services)
docker build -t contentworker:0.1.0 .

# Local (kind/minikube) — bundled Postgres + Redis, self-contained
helm install cw ./infra/helm/contentworker -f ./infra/helm/contentworker/values-local.yaml

# Cloud — set the image registry; secrets come from External Secrets
helm install cw ./infra/helm/contentworker -f ./infra/helm/contentworker/values-aws.yaml \
  --set image.repository=<acct>.dkr.ecr.<region>.amazonaws.com/contentworker
# (likewise values-gcp.yaml / values-azure.yaml)
```

`values-azure.yaml` additionally flips the AI provider to Azure OpenAI
(`AI_PROVIDER=azure-openai`, embeddings too) via config — no rebuild.

## Verify a render

```bash
helm lint ./infra/helm/contentworker -f ./infra/helm/contentworker/values-aws.yaml
helm template cw ./infra/helm/contentworker -f ./infra/helm/contentworker/values-aws.yaml
```

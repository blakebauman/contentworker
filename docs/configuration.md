# Configuration

contentworker is a 12-factor app: **all** configuration is environment variables, and adapter
selection is driven by which ones are set. The same image runs anywhere; only the values change.

## Adapter selection at a glance

| If set… | …this adapter is used | …otherwise |
| --- | --- | --- |
| `DATABASE_URL` | Postgres store + pgvector | in-memory store + in-memory vectors (dev/tests) |
| `REDIS_URL` | Redis cache + BullMQ queue | no cache (fresh reads); worker needs it |
| `BLOB_BUCKET` | S3-compatible blob store | fake in-memory blob store |
| `AI_PROVIDER=azure-openai` | Azure OpenAI generation | Anthropic (default) |
| `EMBEDDINGS_PROVIDER=azure-openai` | Azure OpenAI embeddings | local deterministic embeddings |

## Core / infrastructure

| Var | Default | Purpose |
| --- | --- | --- |
| `ROLE` | `all` | API surface: `all` / `management` / `delivery` / `preview` |
| `PORT` | `8787` (api), `8788` (mcp-server) | HTTP listen port |
| `DATABASE_URL` | — | Postgres connection string; absent → in-memory store |
| `REDIS_URL` | — | Redis connection string; absent → no cache (and the worker won't start) |
| `NODE_ENV` | `production` | Set in the Dockerfile |

## API keys (dev seeds)

| Var | Default | Purpose |
| --- | --- | --- |
| `CMA_KEY` | `dev-cma-key` | Seeded Content Management token (write) |
| `CDA_KEY` | `dev-cda-key` | Seeded Content Delivery token (read published) |
| `CPA_KEY` | `dev-cpa-key` | Seeded Content Preview token (read drafts) |
| `ADMIN_TOKEN` | `dev-admin-token` | Root token — all scopes, all spaces (provisioning) |

In Postgres mode these seeds are not used; create real keys via `POST …/api-keys`.

## Seeding the in-memory store

| Var | Default | Purpose |
| --- | --- | --- |
| `SEED_SPACE_ID` | `space-1` | Seed space id |
| `SEED_ENV_ID` | `master` | Seed environment id |
| `SEED_DEFAULT_LOCALE` | `en-US` | Seed default locale |
| `SEED_LOCALES` | `en-US` | Comma-separated locale list |

## Blob storage (S3-compatible)

| Var | Default | Purpose |
| --- | --- | --- |
| `BLOB_BUCKET` | — | Bucket name; absent → fake blob store |
| `AWS_REGION` | `us-east-1` | Region |
| `BLOB_ENDPOINT` | — | Custom endpoint (MinIO, R2, GCS, Azure interop) |
| `BLOB_FORCE_PATH_STYLE` | — | `true` for MinIO and most S3-compatibles |
| `BLOB_PUBLIC_BASE_URL` | — | When set, download URLs are unsigned public URLs |

Supported backends: AWS S3, Cloudflare R2, MinIO, GCS (S3 interop), Azure Blob (S3 interop).
Uploads use presigned PUT URLs (default 900 s) so file bytes never transit the API.

## AI & embeddings

| Var | Default | Purpose |
| --- | --- | --- |
| `AI_PROVIDER` | `anthropic` | `anthropic` or `azure-openai` |
| `EMBEDDINGS_PROVIDER` | — | `azure-openai`, or local when unset (worker: unset disables RAG) |
| `EMBEDDINGS_DIM` | `1536` | Embedding dimensions (must match the pgvector column) |
| `ANTHROPIC_API_KEY` | — | Anthropic key (default provider) |
| `AZURE_OPENAI_ENDPOINT` | — | e.g. `https://x.openai.azure.com` |
| `AZURE_OPENAI_API_KEY` | — | Azure OpenAI key |
| `AZURE_OPENAI_API_VERSION` | `2024-10-21` | API version |
| `AZURE_OPENAI_DEPLOYMENT` | — | Fallback deployment for all tiers |
| `AZURE_OPENAI_DEPLOYMENT_FLAGSHIP` | — | Deployment for the `flagship` tier (takes precedence) |
| `AZURE_OPENAI_DEPLOYMENT_BALANCED` | — | Deployment for the `balanced` tier |
| `AZURE_OPENAI_DEPLOYMENT_FAST` | — | Deployment for the `fast` tier |
| `AZURE_OPENAI_EMBEDDINGS_DEPLOYMENT` | — | Embeddings deployment name |

Anthropic tier→model: `flagship`→`claude-opus-4-8`, `balanced`→`claude-sonnet-4-6`,
`fast`→`claude-haiku-4-5`. See [AI, agents & search](./ai-agents-and-search.md).

## Worker

| Var | Default | Purpose |
| --- | --- | --- |
| `RELAY_INTERVAL_MS` | `1000` | Outbox poll interval |
| `AGENTS_ENRICH` | `false` | Run the enrich agent on `entry.published` (needs an AI provider) |
| `AGENTS_AUTO_APPLY` | `false` | Auto-apply enrichment vs. route to human review |

The worker **requires** both `DATABASE_URL` and `REDIS_URL`.

## Agent worker (Temporal)

The `apps/agent-worker` runs the durable enrich/moderate workflows against a Temporal cluster.

| Var | Default | Purpose |
| --- | --- | --- |
| `TEMPORAL_ADDRESS` | `localhost:7233` | Temporal frontend address |
| `TEMPORAL_NAMESPACE` | `default` | Temporal namespace |

It registers workflows on the `contentworker-agents` task queue. To route the API/worker's
enrich-on-publish hook through Temporal instead of the in-process runtime, wire a
`TemporalAgentRuntime` (see [AI, agents & search](./ai-agents-and-search.md#agent-runtime)).

## MCP server

| Var | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8788` | HTTP listen port |
| `MCP_TOKEN` | `dev-mcp-token` | Admin bearer token for MCP requests |

The MCP server also honours `DATABASE_URL`, `AI_PROVIDER`, `EMBEDDINGS_PROVIDER`, `EMBEDDINGS_DIM`,
and the `SEED_*` vars.

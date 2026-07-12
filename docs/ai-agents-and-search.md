# AI, agents & search

contentworker treats AI as a first-class client. Everything here ultimately calls the **same
application use-cases** as the HTTP API, so generated and agent-authored content is validated and
authorized identically to human writes.

## AI provider port

`AIProvider` (`packages/ports/src/infra.ts`) is the generation seam. Callers pick a **tier**, not
a model:

```ts
type ModelTier = 'flagship' | 'balanced' | 'fast';

interface GenerateRequest {
  system?: string;
  prompt: string;
  tier?: ModelTier;            // default 'balanced'
  maxTokens: number;
  outputSchema?: Record<string, unknown>;  // when set, provider returns JSON matching this schema
}
interface GenerateResult {
  text: string;
  object?: unknown;            // parsed when outputSchema was supplied
  usage: { inputTokens: number; outputTokens: number };
}
```

### Adapters

**Anthropic** (`@cw/adapter-ai-anthropic`, the default) maps tier → model:

| Tier | Model |
| --- | --- |
| `flagship` | `claude-opus-4-8` |
| `balanced` | `claude-sonnet-4-6` |
| `fast` | `claude-haiku-4-5` |

It sends an adaptive-thinking `effort` parameter for `flagship`/`balanced` (default `medium`,
configurable), and omits it for `fast` (Haiku doesn't accept it). Structured output uses
Anthropic's JSON-schema output format.

**Azure OpenAI** (`@cw/adapter-ai-azure-openai`) routes by **deployment name**, resolved per tier
from `opts.deployments[tier]` → `AZURE_OPENAI_DEPLOYMENT_<TIER>` → `AZURE_OPENAI_DEPLOYMENT`.
Structured output uses `response_format: json_schema` with `strict: true`.

Embeddings are a **separate port** (`EmbeddingsProvider`) because Anthropic ships no embeddings
API. Azure OpenAI provides one (`createAzureOpenAIEmbeddings`, default 1536 dims); the test-kit
provides a deterministic `LocalEmbeddingsProvider` for dev.

## Content generation

`draftEntry(ctx, ai, scope, input)` generates field values for a content type from a natural-language prompt:

```ts
interface DraftEntryInput {
  contentTypeApiId: string;
  prompt: string;
  tier?: ModelTier;            // default 'balanced'
}
```

- It builds a strict JSON Schema (`additionalProperties: false`) from the content type's
  **scalar** fields (`Symbol`, `Text`, `Integer`, `Number`, `Boolean`, `Date` — not links or
  rich text), asks the provider for structured output, then **validates the result against the
  content model** with the same `validateEntryFields` path as human writes.
- Generated values are wrapped in the space's default locale.
- Returns `{ contentTypeApiId, fields, usage }`. Pair it with `createEntry` to actually author.

The rule: *an agent can never produce an entry a person couldn't* — generation output is rejected
if it fails validation.

## Semantic search / RAG

`packages/application/src/rag.ts`, backed by the `VectorStore` + `EmbeddingsProvider` ports
(`RagDeps`).

**Indexing** (on `entry.published`, driven by the worker's event dispatch):

1. `removeEntryEmbeddings` clears any existing vectors for the entry (idempotent).
2. `extractTextByLocale` collects the entry's string values — plus rich-text bodies flattened
   to plain text via `richTextToPlainText` — grouped by locale.
3. `chunk(text, 400)` splits each locale's text into ≤ 400-word, word-bounded chunks.
4. Chunks are embedded (`taskType: 'document'`) and upserted as `VectorRow`s carrying
   `{ scope, entryId, locale, chunkIndex, chunkText, embedding, entryVersion }`.

On `entry.unpublished`, `removeEntryEmbeddings` deletes the entry's vectors.

**Querying** (`semanticSearch(deps, scope, query, { topK = 10, minScore })`):

1. The query is embedded (`taskType: 'query'`).
2. The vector store returns top matches by cosine similarity (over-fetched, then deduplicated to
   the best-scoring chunk per entry).
3. Returns `SearchHit[]` of `{ entryId, score, snippet }`.

The pgvector adapter (`@cw/adapter-vector-pgvector`) stores vectors in a self-initializing
`content_embeddings` table with an HNSW cosine index and records `model_id`/`dimensions` so an
embedding-model swap is detectable.

**Hybrid search** (`hybridSearch(deps, ctx, scope, query, { topK = 10 })`) fuses two legs with
Reciprocal Rank Fusion (`score = Σ 1/(60 + rank)` — rank-based, so the legs' incomparable
scores never need calibrating):

- **Semantic** — `semanticSearch` above.
- **Full-text** — `EntryRepo.searchPublished`, ranked Postgres FTS over the published read
  model: `jsonb_to_tsvector('simple', fields, '["string"]')` matched with
  `websearch_to_tsquery` and ordered by `ts_rank`, backed by the `entry_published_fts` GIN
  expression index. The `simple` regconfig keeps tokenization locale-neutral (content is
  multilingual); the semantic leg supplies linguistic fuzziness. The in-memory store mirrors
  the semantics (every term must match, term-frequency scoring) so hybrid search is testable
  with `@cw/test-kit`.

Lexical-only hits derive their snippet from the published fields. Exposed at
`GET /delivery/:space/:env/search` (hybrid by default; `?mode=semantic` / `?mode=lexical`
selects one leg), the GraphQL `search` resolver, and the `content_search` MCP tool.

## MCP server

`apps/mcp-server` is a **stateless streamable-HTTP** MCP server. Each POST to `/mcp` gets a fresh
server + transport; auth is a bearer token resolved exactly like the HTTP API (admin token or
hashed key). Every tool calls `authorize(principal, scope, space)` before delegating to a
use-case, and `space`/`environment` default to the seeded values when omitted.

### Tools

The MCP server exposes **50+ tools** — one per major Management/Delivery capability. Each tool
calls `authorize` before delegating to the same use-case as the HTTP route.

| Category | Tools |
| --- | --- |
| Model | `model_list_content_types`, `model_get_content_type`, `model_create_content_type`, `model_publish_content_type` |
| Entries | `entries_query`, `entries_get`, `entries_create`, `entries_update`, `entries_publish`, `entries_unpublish`, `entries_bulk_action`, `entries_list_versions`, `entries_diff_versions`, `entries_restore_version`, `entries_set_metadata` |
| AI | `generate_draft`, `entry_from_canvas`, `entry_translate`, `entry_summarize`, `entry_autofill_field`, `entry_suggest_tags`, `entry_audit`, `entry_moderate` |
| Search | `content_search` (hybrid), `content_semantic_search`, `content_related`, `content_duplicates` |
| Roles | `roles_list`, `role_create`, `role_update`, `role_delete` |
| Releases | `releases_list`, `releases_get`, `releases_create`, `releases_add_entry`, `releases_publish` |
| Collaboration | `comments_list`, `comments_add`, `tasks_list`, `tasks_create`, `tasks_resolve`, `workflow_transition` |
| Taxonomy | `taxonomy_list_tags`, `taxonomy_create_tag`, `taxonomy_list_concepts`, `taxonomy_create_concept`, `taxonomy_create_scheme` |
| Assets | `assets_list`, `asset_set_metadata`, `asset_usage`, `asset_generate_alt_text`, `asset_auto_tag`, `asset_transform_url` |
| Branching | `environments_compare`, `environments_merge`, `environment_aliases_list`, `environment_alias_set`, `environment_alias_delete` |
| Platform | `functions_list`, `function_create`, `function_delete`, `app_extensions_list`, `app_extension_create`, `app_extension_delete`, `ai_actions_list`, `ai_action_create`, `ai_action_run`, `schedule_action`, `audit_log_list` |

Canonical list: `apps/mcp-server/src/server.ts`.

Because the tools are thin wrappers over the use-cases, the MCP surface inherits all validation,
referential integrity, RBAC, and event emission for free.

## Agent runtime

`packages/agent-runtime` runs durable agent **workflows** behind an engine-agnostic facade.

```ts
type WorkflowName = 'enrich' | 'moderate' | 'curate' | 'repurpose';
interface AgentRuntime { run(workflow, input): Promise<AgentRunResult>; }
```

On-publish hooks (`AGENTS_ENRICH`, `AGENTS_MODERATE`) run `enrich` then `moderate`. `curate` and
`repurpose` are available for on-demand orchestration (API/MCP/agent-worker).

`AGENT_RUNTIME=temporal` routes on-publish agents through `TemporalAgentRuntime`
(`@cw/agent-runtime/temporal`), which starts workflows on the `contentworker-agents` task queue.
The `apps/agent-worker` hosts the workflow and activity implementations. Default is
`InProcessAgentRuntime` (non-durable).

The crucial seam is `Activities` — the side-effecting operations (`loadEntry`, `generateFields`,
`applyFields`, `classify`, `record`). Workflow functions are **pure orchestration** over
`Activities`, so the *same* workflow code runs:

- **`InProcessAgentRuntime`** — directly in the calling process (dev, tests, single-node). Not
  durable (no crash replay).
- **Temporal** (production) — `apps/agent-worker` hosts `enrich`/`moderate`/`curate`/`repurpose`
  in Temporal's deterministic sandbox. `TemporalAgentRuntime` (`@cw/agent-runtime/temporal`)
  implements the same `AgentRuntime` interface — callers swap executors with no logic change.
  See `packages/agent-runtime/temporal.md`.

### enrich

Fills empty text/symbol fields (excluding the display field) on a freshly-published entry:

1. Load the entry; if missing → `skipped`.
2. Find empty text fields; if none → `skipped`.
3. `generateFields` (tier `fast`) with the existing text as context.
4. If `autoApply` **and** the model filled every requested field → `applyFields` (a new validated
   draft version) → `completed`.
5. Otherwise → `record` the proposal and return `needs_review` with the `proposed` fields (the
   human-in-the-loop path).

### moderate

1. Load the entry; if missing → `skipped`.
2. `classify` the concatenated text (tier `fast`, strict `{ flagged, categories }` schema).
3. If flagged → `record` a hold → `held`; else → `completed`.

### curate

Improves already-filled text/symbol fields (excluding the display field) on a published entry:

1. Load the entry; skip if missing or no filled non-display text fields.
2. `generateFields` with an "improve" instruction; compare proposed vs. current values.
3. If `autoApply` and values changed → `applyFields` → `completed`; else → `needs_review`.

### repurpose

Derives channel variants (e.g. social, newsletter) from entry text:

1. Load the entry; skip if missing or no text.
2. `generateFields` with a repurpose instruction for variant fields.
3. Always records the proposal → `needs_review` (never auto-applies). Pairs with
   `@cw/sdk-email` for newsletter/campaign flows.

### Result

```ts
interface AgentRunResult {
  workflow: WorkflowName;
  entryId: string;
  status: 'completed' | 'needs_review' | 'held' | 'skipped';
  decisions: string[];                  // audit trail
  usage: { inputTokens: number; outputTokens: number };
  proposed?: EntryFields;               // present when needs_review
}
```

The worker runs the on-publish workflows on `entry.published` events: `AGENTS_ENRICH=true`
enables `enrich`, `AGENTS_MODERATE=true` enables `moderate` (enrich runs first so moderation
classifies the enriched content), and `AGENTS_AUTO_APPLY` toggles auto-apply vs. routing
enrichment to human review. Every run is recorded in the agent ledger.

Moderation is also available on demand — `POST .../entries/:id/moderate` (Management API) and
the `entry_moderate` MCP tool both call the same `moderateEntry` use-case, which runs the
workflow in-process and returns `{ flagged, status, decisions, usage }`. A flagged result is a
recorded hold, not a state change: callers (or a webhook consumer) decide whether to unpublish.

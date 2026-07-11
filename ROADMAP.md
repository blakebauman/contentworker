# contentworker roadmap

**Status (audited 2026-07-07):** the platform is implementation-complete for everything
shipped so far — full test suite, typecheck, and lint are green; no TODO/stub/skipped-test
debt in source. Built and verified: the core platform (content model, REST/GraphQL/Preview
delivery, MCP, RAG, durable agents, RBAC, webhooks, assets, multi-cloud Helm, tracing),
the P11–P18 feature waves (query language, releases + scheduled publishing, collaboration,
rich text + taxonomy, audit log, version history + restore, branch merge, environment
aliases, asset metadata + image transforms, media AI, AI/agent actions, content semantics,
bulk API, Live Content API (SSE), functions, app framework, canvas authoring), the
delivery SDK family (`@cw/sdk-core`/`web`/`edge`/`react-native`/`email`), the admin UI
(M0–M7), and CI. Items below are what remains, roughly ordered; checked items are done.

## Admin UI (`apps/admin`, Vite + React)

- [x] **M0 — Scaffold + connection.** Vite + React + TS app; connection bar persisted to
  localStorage; typed Management API client.
- [x] **M1 — Browse + author (MVP).** Content-type list; entry list per type; create/edit
  via generated forms; publish/unpublish.
- [x] **M2 — Rich editing.** Field editors per type, localization tabs, reference pickers.
- [x] **M3 — Media library.** Presigned direct-to-S3 upload, asset grid, entry attachment,
  image transforms (width/height/fit/format/quality, focal-point aware).
- [x] **M4 — Publishing workflow.** Status badges, field-level diff vs published, bulk
  publish/unpublish, scheduled publish/unpublish (Releases view).
- [x] **M5 — Search + dashboards.** Semantic search; agent-run dashboard + token cost
  ledger; webhook delivery log (`WebhookDeliveriesSheet`).
- [x] **M6 — Admin/settings.** API key issuance with one-time reveal; webhook management;
  space + environment creation; environment aliases.
- [x] **M7 — Polish.** Toasts with aria-live; optimistic publish/unpublish/bulk with
  rollback; component tests (jsdom + Testing Library); Playwright e2e (author→publish +
  settings against the in-memory API).

Remaining admin work:

- [ ] **Inline validation surfacing** in entry forms (required/min/max/regex errors at the
  field) + **locale fallback hints** (fallbacks are already fetched via space-config but
  never shown).
- [ ] **Preview-link sharing** — generate/copy a preview URL (and mint a preview token)
  from an entry.
- [ ] **Role editing UI** — the platform side (granular RBAC, below) is done; build the
  admin surface for role CRUD + assigning roles when minting keys.
- [ ] **OIDC/JWT auth** instead of raw bearer tokens — needs an auth-provider decision.

## Platform / SDK

- [x] **Scheduled publishing + versioning/rollback** — `scheduling.ts` + worker tick;
  append-only entry versions with `listVersions`/`restoreVersion` and API routes.
- [x] **Delivery SDKs** — `@cw/sdk-core`, `@cw/sdk-web`, `@cw/sdk-edge`,
  `@cw/sdk-react-native`, `@cw/sdk-email`.
- [ ] **Management SDK** (`@cw/sdk-management`) — extract the admin's hand-written typed
  client (`apps/admin/src/lib/management.ts`) into a published package with codegen'd
  content-type types.
- [ ] **OpenAPI spec** generated from the Zod route schemas; publish API docs.
- [x] **Granular RBAC** — custom `Role`s (space-scoped, live-resolved on every request)
  carry a scope set plus per-content-type grants (`read`/`write`/`publish`) with per-field
  deny/read-only rules. API keys bind via `roleId`; enforcement is identical on HTTP and MCP
  (write/publish guards, read filtering + field masking on management/preview/delivery).
  Roles CRUD at `/spaces/:space/roles` + `role_*` MCP tools. _(GraphQL/search/SSE/assets
  remain coarse-scope only; per-field rules on those surfaces are a follow-up.)_
- [x] **Temporal in production** — `AGENT_RUNTIME=temporal` binds `TemporalAgentRuntime`
  in `apps/worker` (env-driven; in-process remains the default); the **curate** and
  **repurpose** workflows join enrich/moderate (registered on the Temporal worker, tested
  against a real ephemeral server); the Helm chart bundles the official Temporal subchart
  (`temporal.enabled`, persistence on the platform Postgres) and deploys the agent-worker
  automatically when the durable runtime is selected. _(Temporal Schedules for periodic
  curate/repurpose runs + HITL via Signals TODO.)_
- [x] **Wire the `moderate` agent** — `AGENTS_MODERATE=true` runs it on `entry.published`
  (after enrich, so moderation sees enriched content; `runPublishAgents` in the worker),
  and it runs on demand via `POST …/entries/:id/moderate` + the `entry_moderate` MCP tool
  (both call the same `moderateEntry` use-case). A flagged result is a recorded hold
  (`flagged: true`) in the agent ledger, not a state change — callers decide. _(A hard
  moderation gate that blocks/unpublishes on flag remains TODO.)_
- [x] **Hybrid search** — `hybridSearch` fuses pgvector ANN with ranked Postgres FTS
  (`jsonb_to_tsvector('simple')` + `websearch_to_tsquery` + `ts_rank`, GIN expression index
  `entry_published_fts`) via Reciprocal Rank Fusion. Default for `GET …/search` (`?mode=`
  selects a single leg), the GraphQL `search` resolver, and the new `content_search` MCP
  tool. _(The `EntryQuery.search` list-filter path still runs JS-side — pushing it down to
  the same tsvector is a follow-up optimization.)_

## Ops / hardening

- [x] **CI** — GitHub Actions: biome lint, `helm lint`, typecheck, `pnpm -r test` with
  ephemeral Postgres 16 + Redis 7 service containers (adapter contract suites enabled via
  `TEST_DATABASE_URL`/`TEST_REDIS_URL`), admin build.
- [ ] **OTel metrics** (tracing exists; no meters/counters/histograms) +
  Prometheus/Grafana dashboards; KEDA queue-depth autoscaling for the worker (HPA only).
- [ ] **Rate limiting** + request-size limits at the API edge.
- [ ] **External Secrets** — docs and per-cloud Helm values exist; add
  `ExternalSecret`/`SecretStore` templates to the chart and produce a live multi-cloud
  deploy proof.

## New product scope (beyond the original brief)

- [ ] Hosted multi-tenant SaaS control plane (org/billing/usage metering).
- [ ] Multi-region read replicas + edge delivery caching.
- [ ] Per-environment content migration/diff tooling (promote main→staging).

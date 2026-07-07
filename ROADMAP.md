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
- [ ] **Role editing UI** — blocked on granular RBAC (below); access is still coarse
  CMA/CDA/CPA key kinds.
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
- [ ] **Granular RBAC** — per-content-type and per-field permissions, custom roles
  (beyond the CMA/CDA/CPA kinds + coarse scopes in `domain/auth`).
- [ ] **Temporal in production** — `TemporalAgentRuntime` + `apps/agent-worker` exist and
  pass a real ephemeral-server test; remaining: bind it in `apps/worker` (env-driven,
  currently hardcoded to `InProcessAgentRuntime`), add a Temporal Helm subchart, and build
  the **curate** and **repurpose** workflows.
- [ ] **Wire the `moderate` agent** — the workflow is implemented, durable-capable, and
  tested, but nothing triggers it in production and no API/MCP surface runs it. Decide the
  trigger (e.g. moderation gate on publish, or an on-demand API/MCP action) and wire it.
- [ ] **Hybrid search** — combine pgvector ANN with Postgres full-text (RRF). Today ANN
  and full-text are separate paths, and full-text runs JS-side rather than as Postgres FTS.

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

# contentworker roadmap

The core platform (content model, REST/GraphQL/Preview delivery, MCP, RAG,
durable agents, RBAC, webhooks, assets, multi-cloud Helm, telemetry) is built and
verified. This roadmap covers what's next — an **admin UI** plus remaining
platform/ops work. Items are roughly ordered; checked items are done.

## Admin UI (`apps/admin`, Vite + React)

A web console for editors/admins, talking to the Management/Preview APIs.

- [x] **M0 — Scaffold + connection.** Vite + React + TS app; connection bar
  (API URL, bearer token, space, environment) persisted to localStorage; typed
  Management API client.
- [x] **M1 — Browse + author (MVP).** Content-type list; entry list per type;
  create/edit entry via a form generated from field definitions; publish/unpublish.
- [x] **M2 — Rich editing.** Field editors per type (rich text, number, boolean,
  date, location, JSON), localization tabs (per-locale values, backed by a new
  `GET …/space-config` locale list), reference pickers (link to entry/asset).
  _(Inline validation surfacing + fallback hints TODO.)_
- [x] **M3 — Media library.** Asset upload via presigned PUT (direct-to-S3),
  asset grid, attach assets to entries (reference pickers). _(CDN transforms TODO.)_
- [x] **M4 — Publishing workflow.** Draft/changed/published status badges,
  diff vs published (field-level draft-vs-delivery), bulk publish/unpublish.
  _(Scheduled publish + preview-link sharing TODO.)_
- [x] **M5 — Search + dashboards.** Semantic search box; agent-run dashboard
  (status, decisions) + token **cost ledger**. _(Webhook delivery log TODO.)_
- [x] **M6 — Admin/settings.** API key issuance (CMA/CDA/CPA) with one-time token
  reveal + scope display; webhook create/list with topic selection.
  _(Space/env management + role editing TODO.)_
- [~] **M7 — Polish.** Toast notifications (success/error) with an aria-live
  region replacing inline error bars across all views; optimistic publish/
  unpublish/bulk with rollback-on-error; React component tests (jsdom + Testing
  Library) and Playwright e2e (author→publish + settings, against the in-memory
  API via a Vite proxy). _(Remaining: OIDC/JWT auth instead of raw tokens — needs
  an auth-provider decision.)_

## Platform / SDK

- [ ] **Management SDK** (`@cw/sdk-management`) — extract the admin's typed client
  into a published package with codegen'd content-type types.
- [ ] **OpenAPI spec** generated from the Zod route schemas; publish API docs.
- [ ] **Granular RBAC** — per-content-type and per-field permissions, custom
  roles (beyond the CMA/CDA/CPA kinds + coarse scopes).
- [ ] **Scheduled publishing** + content versioning UI / rollback.
- [ ] **Temporal in production** — wire `apps/worker` enrich-on-publish to
  `TemporalAgentRuntime`; add a Temporal Helm subchart; build the **curate** and
  **repurpose** agent workflows.
- [ ] **Hybrid search** — combine pgvector ANN with Postgres full-text (RRF).

## Ops / hardening

- [ ] **OTel metrics** (not just traces) + Prometheus/Grafana dashboards;
  KEDA queue-depth autoscaling for the worker.
- [ ] **Rate limiting** + request-size limits at the API edge.
- [ ] **CI** — GitHub Actions running `pnpm -r test` + typecheck + lint +
  `helm lint`; integration tests against ephemeral Postgres/Redis.
- [ ] **External Secrets** wiring docs per cloud; live multi-cloud deploy proof.

## New product scope (beyond the original brief)

- [ ] Hosted multi-tenant SaaS control plane (org/billing/usage metering).
- [ ] Multi-region read replicas + edge delivery caching.
- [ ] Per-environment content migration/diff tooling (promote main→staging).

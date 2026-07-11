# Admin UI

The admin SPA (`apps/admin`, package `@cw/admin`) is a React + Vite management console for
authoring content, running releases, configuring workflows, and using AI-assisted editing. It
talks to the **same Management API** as any other CMA client — no separate backend.

## Running locally

### Docker Compose (recommended)

```bash
docker compose up --build
```

- **Admin:** http://localhost:5173
- **API:** http://localhost:8787

Compose auto-loads `docker-compose.override.yml`, which runs the admin as a Vite dev server with
HMR and bind-mounted source. See [Deployment → Admin service](./deployment.md#admin-service-base-vs-override).

Sign in at `/connect` with a CMA key or admin token. In dev, docker-compose seeds `dev-cma-key`
automatically; production builds require an explicit token. Optional SSO: set `VITE_SSO_LOGIN_URL`
to your admin BFF `/auth/login` endpoint.

### Host dev server

With the API running (in-memory or against Postgres):

```bash
pnpm --filter @cw/api start          # or docker compose up api
pnpm --filter @cw/admin dev          # http://localhost:5173
```

The Vite dev server proxies `/spaces`, `/preview`, `/delivery`, and `/auth` to the API (see
`apps/admin/vite.config.ts`), so the browser stays same-origin and avoids CORS.

### Prod-style preview in Docker

To serve a built bundle instead of the dev server:

```bash
docker compose -f docker-compose.yml up --build
```

This uses `build && vite preview` from the base compose file (no HMR, no bind mounts).

## Environment variables

| Var | Default | Purpose |
| --- | --- | --- |
| `CW_API_URL` | `http://localhost:8787` | API target for the Vite proxy |
| `CW_ADMIN_PORT` | `5173` | Listen port (`strictPort` when set — used by e2e) |
| `VITE_USE_POLLING` | — | Set to `true` in Docker override for HMR over bind mounts |

These are documented in [Configuration](./configuration.md#admin-spa).

## Features

The admin covers the main Management API capabilities:

- **Dashboard** — usage, throughput, live activity
- **Entries** — list, filter, create, edit, publish, version history, diff, restore
- **Content types** — schema editor
- **Releases** — bundle entries/assets and publish as a unit
- **Workflows** — editorial state machines and per-entry transitions
- **Taxonomy** — schemes, concepts, tags; entry metadata associations
- **Media library** — assets, metadata, alt-text, transforms
- **Collaboration** — comments and tasks on entries
- **AI** — generate, canvas, translate, summarize, autofill, suggest-tags, audit, moderate
- **Settings** — API keys, roles, webhooks, environment aliases, branch compare/merge
- **Platform** — functions, app extensions (iframe panels), AI actions, agent-run audit

Extension panels load registered `app-extensions` in iframes (`ExtensionFrame`).

## Testing

```bash
pnpm --filter @cw/admin test           # Vitest component/unit tests
pnpm --filter @cw/admin exec playwright test   # e2e (needs API + admin running)
```

E2E uses `CW_ADMIN_PORT` and `CW_API_URL` from `playwright.config.ts` / `e2e/global-setup.ts`.

## Architecture note

The admin is **not** a composition root — it is a browser client only. All business logic,
validation, and RBAC run in `@cw/application` via the HTTP API. When adding a capability,
expose it through the API (and MCP) first; the admin calls the existing routes through
`apps/admin/src/lib/management.ts`.

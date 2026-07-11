# apps/*

- These are the **only composition roots**: adapters are bound to ports exclusively in
  `api/src/wire.ts`, `worker/src/main.ts`, `agent-worker/src/main.ts`, `mcp-server/src/wire.ts`.
  Nothing under `packages/` may import an adapter.
- Adapter selection is env-driven (12-factor). Any new env var must be reflected everywhere:
  the wire/main that reads it, `docker-compose.yml`, the Helm configmap/secret templates and
  **all** values files (aws/gcp/azure/local), and `docs/configuration.md`.
- Routes and MCP tools are thin: authorize (`requireScope` against the route's `:space`),
  parse, call the application use-case, serialize. Business logic never lives here — and every
  capability must be exposed through **both** the API and the MCP server.
- `@cw/migrator` has no test/typecheck target; CI filters it with `--filter '!@cw/migrator'`.
  Keep it that way.

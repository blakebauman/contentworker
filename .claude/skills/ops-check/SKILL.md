---
name: ops-check
description: Validate deployability — helm lint/template all values files, docker compose config, env-var and CI parity
context: fork
agent: ops-engineer
allowed-tools: Read, Grep, Glob, Bash
---

Run the full deployability validation (read-only — do not edit anything):

1. `docker compose config -q`
2. `helm dependency update infra/helm/contentworker`
3. `helm lint infra/helm/contentworker`, then `helm template` with the default values and each
   of `values-aws.yaml`, `values-gcp.yaml`, `values-azure.yaml`, `values-local.yaml`.
4. **Env-var parity**: collect env vars read in `apps/*/wire.ts` and `apps/worker/src/main.ts`
   (grep `process.env`), and diff that set against `docker-compose.yml`, the Helm
   configmap/secret templates + values files, and `docs/configuration.md`. Report vars missing
   from any surface.
5. **CI parity**: `.github/workflows/ci.yml` service images must match compose
   (postgres:16 / redis:7), and its steps must still mirror the documented local commands
   (lint, helm lint, typecheck excluding `@cw/migrator`, migrations, tests, admin build).

Output a table — check | status (PASS/FAIL/WARN) | fix — followed by the first failing
command's output verbatim if anything failed.

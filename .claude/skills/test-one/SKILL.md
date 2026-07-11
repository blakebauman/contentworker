---
name: test-one
description: Fast path to run one package's tests, one test file, or one test by name
argument-hint: "<pkg> [file.test.ts | -t 'test name']"
---

Run the requested tests using the narrowest matching form:

```bash
pnpm --filter @cw/<pkg> test                       # whole package
pnpm --filter @cw/<pkg> test -- <file>.test.ts     # one file
pnpm --filter @cw/<pkg> test -- -t 'name of test'  # one test by name
```

Arguments: $ARGUMENTS — if the package is given without the `@cw/` prefix, add it.

Notes:
- `@cw/migrator` has no test target; never try to run it.
- Adapter contract tests auto-skip unless env is set: `TEST_DATABASE_URL=postgres://localhost:5432/contentworker_test`
  for store-postgres, `TEST_REDIS_URL=redis://localhost:6379` for redis
  (spin up infra with `docker compose up -d postgres redis` if needed).
- Application test files (named by capability) currently on disk:

!`ls packages/application/test`

Report pass/fail with the failing output verbatim if anything fails.

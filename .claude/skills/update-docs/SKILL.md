---
name: update-docs
description: Sync docs/ with the code — find stale docs for the current diff (or a given range/area) and update them
argument-hint: "[base ref | area, default: working tree + HEAD vs main]"
context: fork
agent: docs-keeper
---

Bring the documentation in line with the code, per your system prompt.

Target: $ARGUMENTS (if empty, cover the working tree plus commits since `main` —
`git diff --name-only main...HEAD` plus uncommitted changes; if a doc area or topic was given
instead of a ref, audit that area against the current code).

Changed files:

!`git diff --stat main...HEAD 2>/dev/null | tail -30`

!`git status --short`

1. Map the delta through your code → doc table and read the current code before editing.
2. Update every affected doc, including `docs/README.md` if the doc set changed.
3. Run the parity hotspot cross-checks (env vars, routes, dev commands) regardless of the diff.

Finish with the per-file summary: doc → change → driving code fact, plus unverifiable items
as open questions.

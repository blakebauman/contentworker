---
name: review-arch
description: Run the hexagonal dependency-rule and dual-surface architecture review on the current diff
argument-hint: "[base ref, default: working tree vs HEAD]"
context: fork
agent: hexagonal-guardian
---

Review the current changes against the hexagonal dependency rule, per your system prompt.

Base ref: $ARGUMENTS (if empty, review the working tree + staged changes against HEAD).

Changed files:

!`git diff --stat HEAD`

Specifically verify:
1. Every changed file's imports respect its layer.
2. Any new/renamed application use-case is exposed through **both** an `apps/api` route
   (with `requireScope`) and an `apps/mcp-server` tool.
3. Publish paths keep read-model write + outbox append inside one `withTransaction`.

Report `PASS` or `VIOLATIONS (n)` with file:line and the layer-correct fix for each.

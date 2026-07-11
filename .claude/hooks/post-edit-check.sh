#!/usr/bin/env bash
# PostToolUse check (Edit|Write|MultiEdit) for .ts/.tsx files:
#   1. Biome auto-fix; remaining *errors* block (exit 2).
#   2. Dependency-rule guard: inner packages importing adapters/infra libs block.
#   3. Convention pattern greps surface as non-blocking additionalContext warnings.
set -uo pipefail

input=$(cat)
file=$(jq -r '.tool_input.file_path // empty' <<<"$input")
[[ -z "$file" || ! -f "$file" ]] && exit 0
case "$file" in *.ts | *.tsx) ;; *) exit 0 ;; esac

root="${CLAUDE_PROJECT_DIR:-$(pwd)}"
rel="${file#"$root"/}"
errors=()
notes=()

# 1) Biome: auto-fix formatting + safe lint fixes; fail only on remaining errors
#    (--diagnostic-level=error keeps warnings like noExplicitAny from nagging).
biome_out=$(cd "$root" && pnpm exec biome check --write --diagnostic-level=error "$rel" 2>&1) ||
  errors+=("Biome errors remain in $rel after auto-fix:"$'\n'"$biome_out")

# 2) Dependency-rule guard — inner packages must not import outward.
case "$rel" in
  packages/domain/src/* | packages/ports/src/* | packages/application/src/* | packages/test-kit/src/*)
    bad=$(grep -nE "from '(@cw/adapter-|drizzle-orm|postgres|ioredis|bullmq|@aws-sdk|hono)" "$file" || true)
    [[ -n "$bad" ]] && errors+=("Dependency-rule violation in $rel — inner packages must not import adapters/infra libs (only apps/* bind adapters to ports):"$'\n'"$bad")
    ;;
  packages/agent-runtime/src/*)
    bad=$(grep -nE "from '@cw/adapter-" "$file" || true)
    [[ -n "$bad" ]] && errors+=("Dependency-rule violation in $rel — agent-runtime must stay engine-agnostic; adapters are bound only in apps/*:"$'\n'"$bad")
    ;;
esac
case "$rel" in
  packages/domain/src/* | packages/ports/src/*)
    bad=$(grep -nE "from '@cw/application" "$file" || true)
    [[ -n "$bad" ]] && errors+=("Dependency-rule violation in $rel — domain/ports must never import @cw/application:"$'\n'"$bad")
    ;;
esac

# 3) Non-blocking convention warnings.
if [[ "$rel" != *.test.ts && "$rel" != */test/* ]]; then
  if grep -qnE 'crypto\.randomUUID|uuidv4\(' "$file"; then
    notes+=("$rel uses crypto.randomUUID/uuidv4 — IDs are UUIDv7 generated via the injected IdGenerator: use ctx.ids.newId().")
  fi
fi
if grep -qnE '\b(Sanity|Contentful)\b' "$file"; then
  notes+=("$rel mentions a competitor CMS by name — never reference competitor products in code, comments, or docs. Rephrase (e.g. 'other headless CMSes').")
fi
case "$rel" in
  packages/application/src/* | packages/domain/src/*)
    if grep -qn 'new Date(' "$file"; then
      notes+=("$rel contains new Date( — use ctx.clock.now() for current time in use-cases. Parsing an ISO string with new Date(str) is fine; verify which this is.")
    fi
    ;;
esac
[[ "$rel" == packages/adapters/store-postgres/src/schema.ts ]] && notes+=(
  "schema.ts changed: run 'pnpm --filter @cw/adapter-store-postgres generate', inspect the new SQL under drizzle/, and commit both together. Never hand-edit drizzle/."
)

if ((${#errors[@]})); then
  printf '%s\n\n' "${errors[@]}" >&2
  ((${#notes[@]})) && printf '%s\n' "${notes[@]}" >&2
  exit 2
fi
if ((${#notes[@]})); then
  jq -n --arg ctx "$(printf '%s\n' "${notes[@]}")" \
    '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $ctx}}'
fi
exit 0

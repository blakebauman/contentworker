# Images for the contentworker Node services (api, worker, mcp-server,
# agent-worker, migrator). Services run via tsx (a production dependency of
# each app), so no compile step is needed; the command is chosen per service in
# docker-compose.yml / the Helm chart.
#
# Stages:
#   dev    — full install (dev deps included). Used by docker-compose's admin
#            service, which builds the SPA with vite inside the container.
#   deploy — intermediate: `pnpm deploy` prunes the workspace down to ONE app
#            and only the production dependencies its dependency graph needs.
#   app    — slim per-app runtime built from the deploy stage. One image per
#            service, no pnpm/workspace inside:
#              docker build --target app --build-arg APP=api \
#                --build-arg APP_ENTRY=src/server.ts -t contentworker-api .
#            (APP_ENTRY defaults to src/main.ts — only the api differs.)
#            Enable in the Helm chart with `image.perApp: true`.
#   prod   — the shared whole-monorepo image (production deps only, non-root).
#            Default target; docker-compose and the Helm default deploy this:
#            no typescript/vite/vitest/drizzle-kit in the runtime image.

FROM node:22-alpine AS dev

RUN corepack enable
WORKDIR /app

COPY --chown=node:node pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
# Root tsconfig is referenced by package tsconfigs (e.g. the admin vite build).
COPY --chown=node:node tsconfig.base.json turbo.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps ./apps
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@cw/api", "start"]

FROM node:22-alpine AS deploy

RUN corepack enable
WORKDIR /workspace

COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
# One app + the production subset of its workspace dependency graph, copied
# into a self-contained /out (no symlinks into a shared store). --legacy is
# pnpm 10's pre-inject deploy behavior — workspace packages here export TS
# sources run by tsx, so publish-style injection is unnecessary.
ARG APP=api
RUN pnpm --filter "@cw/${APP}" deploy --legacy --prod /out

FROM node:22-alpine AS app

WORKDIR /app
ENV NODE_ENV=production
# Entrypoint within the app package: src/server.ts for the api, src/main.ts
# for every other service. Promoted to ENV so CMD can exec it (sh execs node,
# so signals still reach the process — graceful SIGTERM shutdown intact).
ARG APP_ENTRY=src/main.ts
ENV APP_ENTRY=${APP_ENTRY}
COPY --from=deploy --chown=node:node /out /app
USER node
CMD ["sh", "-c", "exec node --import tsx \"$APP_ENTRY\""]

FROM node:22-alpine AS prod

RUN corepack enable
WORKDIR /app

COPY --chown=node:node pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY --chown=node:node tsconfig.base.json turbo.json ./
COPY --chown=node:node packages ./packages
COPY --chown=node:node apps ./apps
# Production dependencies only: tsx (the runtime loader) is a prod dependency
# of every app; build/test toolchains never reach this image.
RUN pnpm install --frozen-lockfile --prod && pnpm store prune

ENV NODE_ENV=production
USER node
CMD ["pnpm", "--filter", "@cw/api", "start"]

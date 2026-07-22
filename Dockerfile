# Shared image for all contentworker Node services (api, worker, mcp-server,
# agent-worker, migrator). Services run via tsx (a production dependency of
# each app), so no compile step is needed; the command is chosen per service in
# docker-compose.yml / the Helm chart.
#
# Two stages:
#   dev  — full install (dev deps included). Used by docker-compose's admin
#          service, which builds the SPA with vite inside the container.
#   prod — production dependencies only, runs as the non-root `node` user.
#          This is the default target and the image the Helm chart deploys:
#          no typescript/vite/vitest/drizzle-kit in the runtime image.

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

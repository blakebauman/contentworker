# Shared image for all contentworker Node services (api, worker, migrator).
# Services run via tsx, so no compile step is needed; the command is chosen
# per service in docker-compose.yml / the Helm chart.
FROM node:22-alpine

RUN corepack enable
WORKDIR /app

# Install dependencies first for better layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
# Root tsconfig is referenced by package tsconfigs (e.g. the admin vite build).
COPY tsconfig.base.json turbo.json ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --prod=false

ENV NODE_ENV=production
# Default command runs the API; overridden per service.
CMD ["pnpm", "--filter", "@cw/api", "start"]

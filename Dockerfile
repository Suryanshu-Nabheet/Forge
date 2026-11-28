# Forge — production image.
# Multi-stage: install + next build in the builder, then a slim runtime
# with git (needed for the transports), the workspace source (the custom
# server runs via tsx), and the prebuilt .next output.

# ---------- builder ----------
FROM node:22-slim AS builder
RUN corepack enable
WORKDIR /app

# Workspace manifests first for install caching.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json turbo.json ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/git/package.json packages/git/package.json
COPY packages/jobs/package.json packages/jobs/package.json
COPY packages/ai/package.json packages/ai/package.json
COPY packages/sandbox/package.json packages/sandbox/package.json
RUN pnpm install --frozen-lockfile

# Sources + build the Next.js output.
COPY . .
RUN pnpm --filter @forge/web exec next build

# ---------- runtime ----------
FROM node:22-slim AS runtime
RUN corepack enable && apt-get update \
  && apt-get install -y --no-install-recommends git curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production FORGE_PORT=3000 FORGE_SSH_PORT=2222 FORGE_STORAGE_ROOT=/data

# Prod dependency graph + the workspace sources.
COPY --from=builder /app ./

# Storage root for bare repos (mount a volume here).
RUN mkdir -p /data
VOLUME /data

EXPOSE 3000 2222
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD curl -fsS http://localhost:3000/healthz || exit 1

# Custom server: Next UI + git HTTP + SSH + hooks + worker in one process.
CMD ["pnpm", "--filter", "@forge/web", "start"]

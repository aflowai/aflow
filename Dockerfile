# =============================================================================
# Aflow — multi-stage Dockerfile
# Works with any Docker host, including Cloud Run
#
# Usage:
#   docker build -t phoenix .
#   docker run -e PHOENIX_PROFILE=web-core -e PORT=3000 phoenix
#   docker run -e PHOENIX_PROFILE=ai-worker phoenix
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1: Install dependencies and build
# ---------------------------------------------------------------------------
FROM node:22.23.3-alpine3.24 AS builder

# Enable Corepack for Yarn 4 (Berry)
RUN corepack enable

WORKDIR /app

# Copy package manifests first (layer caching)
# Corepack + .yarnrc.yml handle Yarn version; .yarn/ dir is only an install-state cache
COPY package.json yarn.lock .yarnrc.yml ./

# Copy all workspace package.json files
COPY apps/server/package.json apps/server/
COPY packages/server-runtime/package.json packages/server-runtime/
COPY apps/aflow-orchestrator/package.json apps/aflow-orchestrator/
COPY apps/aflow-executor-ai/package.json apps/aflow-executor-ai/
COPY apps/aflow-executor-api/package.json apps/aflow-executor-api/
COPY apps/aflow-executor-user/package.json apps/aflow-executor-user/
COPY apps/aflow-executor-memory/package.json apps/aflow-executor-memory/
COPY apps/aflow-executor-mock/package.json apps/aflow-executor-mock/
COPY apps/aflow-executor-ui/package.json apps/aflow-executor-ui/
COPY apps/aflow-executor-compute/package.json apps/aflow-executor-compute/
COPY apps/aflow-executor-mcp/package.json apps/aflow-executor-mcp/
COPY apps/aflow-executor-host/package.json apps/aflow-executor-host/
COPY apps/aflow-mcp/package.json apps/aflow-mcp/
COPY packages/web-product/package.json packages/web-product/
COPY apps/web-local/package.json apps/web-local/
COPY packages/schemas/package.json packages/schemas/
COPY packages/database/package.json packages/database/
COPY packages/redis/package.json packages/redis/
COPY packages/payload-store/package.json packages/payload-store/
COPY packages/ai-client/package.json packages/ai-client/
COPY packages/executor-runtime/package.json packages/executor-runtime/
COPY packages/input-resolution/package.json packages/input-resolution/
COPY packages/observability/package.json packages/observability/
COPY packages/design-system/package.json packages/design-system/
COPY packages/lib/package.json packages/lib/
COPY packages/network-safety/package.json packages/network-safety/
COPY packages/authz/package.json packages/authz/
COPY packages/credential-resolver/package.json packages/credential-resolver/
COPY packages/surface-engine/package.json packages/surface-engine/
COPY packages/memory-paths/package.json packages/memory-paths/
COPY packages/memory-store/package.json packages/memory-store/
COPY packages/cybernetic-hooks/package.json packages/cybernetic-hooks/
COPY packages/cybernetic-runtime/package.json packages/cybernetic-runtime/
COPY packages/platform-artifacts/package.json packages/platform-artifacts/
COPY packages/run-view/package.json packages/run-view/
COPY packages/applet-runtime/package.json packages/applet-runtime/
COPY packages/integration-simulator/package.json packages/integration-simulator/
COPY packages/oauth/package.json packages/oauth/
COPY packages/ui-artifact-compiler/package.json packages/ui-artifact-compiler/

# Install all dependencies (including devDependencies for build)
# Skip postinstall scripts — source isn't copied yet, packages are built later via `yarn build`
RUN yarn install --immutable --mode=skip-build

# Copy source code
COPY tsconfig.base.json ./
COPY packages/ packages/
COPY apps/ apps/
COPY scripts/prod-launcher.mjs scripts/release.mjs scripts/postinstall.mjs scripts/rewrap-credentials.mjs scripts/

# Build all packages and apps (topological order)
# Inlined into the client bundle and into the CSP `connect-src` at build time,
# so a value supplied at runtime would change neither. Unset builds exactly as
# before.
ARG NEXT_PUBLIC_API_ORIGIN
ENV NEXT_PUBLIC_API_ORIGIN=${NEXT_PUBLIC_API_ORIGIN}

RUN yarn build

# Next keeps an incremental build cache under `.next/cache`. It is for the next
# build on this machine, and there is never another one — the production stage
# copies `.next` wholesale, so the cache would ship. Removed here rather than
# after the copy: a later `rm` leaves the bytes in the layer the COPY made, and
# a pull carries every layer.
# Globbed rather than listing each application: naming a workspace here means a
# line an edition cut has to prune, and `pruneDockerfile` only rewrites COPY.
RUN rm -rf apps/*/.next/cache

# ---------------------------------------------------------------------------
# Stage 2: Production image (slim)
# ---------------------------------------------------------------------------
FROM node:22.23.3-alpine3.24 AS production

# The source label is what links a published image to its repository: the
# registry shows that repository's README and grants its workflows access.
LABEL org.opencontainers.image.source="https://github.com/aflowai/aflow" \
      org.opencontainers.image.description="Aflow Local — an agentic execution platform you run yourself" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

# Docker CLI for compute executor (talks to host daemon via mounted socket)
RUN apk add --no-cache docker-cli

RUN corepack enable

# npm ships with the base image and nothing here runs it — the image installs
# and runs through corepack's Yarn — so it is removed rather than carried along
# with its own dependency tree for the vulnerability scan to find.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx

WORKDIR /app

# Copy package manifests + lock for production install
COPY package.json yarn.lock .yarnrc.yml ./

# Copy all workspace package.json files (needed for yarn to resolve workspaces)
COPY --from=builder /app/apps/server/package.json apps/server/
COPY --from=builder /app/packages/server-runtime/package.json packages/server-runtime/
COPY --from=builder /app/apps/aflow-orchestrator/package.json apps/aflow-orchestrator/
COPY --from=builder /app/apps/aflow-executor-ai/package.json apps/aflow-executor-ai/
COPY --from=builder /app/apps/aflow-executor-api/package.json apps/aflow-executor-api/
COPY --from=builder /app/apps/aflow-executor-user/package.json apps/aflow-executor-user/
COPY --from=builder /app/apps/aflow-executor-memory/package.json apps/aflow-executor-memory/
COPY --from=builder /app/apps/aflow-executor-mock/package.json apps/aflow-executor-mock/
COPY --from=builder /app/apps/aflow-executor-ui/package.json apps/aflow-executor-ui/
COPY --from=builder /app/apps/aflow-executor-compute/package.json apps/aflow-executor-compute/
COPY --from=builder /app/apps/aflow-executor-mcp/package.json apps/aflow-executor-mcp/
# Manifest only. The lockfile names this workspace so the production install
# must resolve it, but it ships outside the image and has no dist copy below.
COPY --from=builder /app/apps/aflow-executor-host/package.json apps/aflow-executor-host/
COPY --from=builder /app/apps/aflow-mcp/package.json apps/aflow-mcp/
COPY --from=builder /app/packages/web-product/package.json packages/web-product/
COPY --from=builder /app/apps/web-local/package.json apps/web-local/
COPY --from=builder /app/packages/schemas/package.json packages/schemas/
COPY --from=builder /app/packages/database/package.json packages/database/
COPY --from=builder /app/packages/redis/package.json packages/redis/
COPY --from=builder /app/packages/payload-store/package.json packages/payload-store/
COPY --from=builder /app/packages/ai-client/package.json packages/ai-client/
COPY --from=builder /app/packages/executor-runtime/package.json packages/executor-runtime/
COPY --from=builder /app/packages/input-resolution/package.json packages/input-resolution/
COPY --from=builder /app/packages/observability/package.json packages/observability/
COPY --from=builder /app/packages/design-system/package.json packages/design-system/
COPY --from=builder /app/packages/lib/package.json packages/lib/
COPY --from=builder /app/packages/network-safety/package.json packages/network-safety/
COPY --from=builder /app/packages/authz/package.json packages/authz/
COPY --from=builder /app/packages/credential-resolver/package.json packages/credential-resolver/
COPY --from=builder /app/packages/surface-engine/package.json packages/surface-engine/
COPY --from=builder /app/packages/memory-paths/package.json packages/memory-paths/
COPY --from=builder /app/packages/memory-store/package.json packages/memory-store/
COPY --from=builder /app/packages/cybernetic-hooks/package.json packages/cybernetic-hooks/
COPY --from=builder /app/packages/cybernetic-runtime/package.json packages/cybernetic-runtime/
COPY --from=builder /app/packages/platform-artifacts/package.json packages/platform-artifacts/
COPY --from=builder /app/packages/run-view/package.json packages/run-view/
COPY --from=builder /app/packages/applet-runtime/package.json packages/applet-runtime/
COPY --from=builder /app/packages/integration-simulator/package.json packages/integration-simulator/
COPY --from=builder /app/packages/oauth/package.json packages/oauth/
COPY --from=builder /app/packages/ui-artifact-compiler/package.json packages/ui-artifact-compiler/

# Install production dependencies only
# Copy postinstall script first — it exits early when NODE_ENV=production
ENV NODE_ENV=production
COPY --from=builder /app/scripts/postinstall.mjs scripts/
RUN yarn workspaces focus --all --production

# Copy compiled output from builder
COPY --from=builder /app/packages/schemas/dist packages/schemas/dist
COPY --from=builder /app/packages/database/dist packages/database/dist
COPY --from=builder /app/packages/redis/dist packages/redis/dist
COPY --from=builder /app/packages/payload-store/dist packages/payload-store/dist
COPY --from=builder /app/packages/ai-client/dist packages/ai-client/dist
COPY --from=builder /app/packages/executor-runtime/dist packages/executor-runtime/dist
COPY --from=builder /app/packages/input-resolution/dist packages/input-resolution/dist
COPY --from=builder /app/packages/observability/dist packages/observability/dist
COPY --from=builder /app/packages/design-system/dist packages/design-system/dist
COPY --from=builder /app/packages/lib/dist packages/lib/dist
COPY --from=builder /app/packages/network-safety/dist packages/network-safety/dist
COPY --from=builder /app/packages/authz/dist packages/authz/dist
COPY --from=builder /app/packages/credential-resolver/dist packages/credential-resolver/dist
COPY --from=builder /app/packages/surface-engine/dist packages/surface-engine/dist
COPY --from=builder /app/packages/memory-paths/dist packages/memory-paths/dist
COPY --from=builder /app/packages/memory-store/dist packages/memory-store/dist
COPY --from=builder /app/packages/cybernetic-hooks/dist packages/cybernetic-hooks/dist
COPY --from=builder /app/packages/cybernetic-runtime/dist packages/cybernetic-runtime/dist
COPY --from=builder /app/packages/platform-artifacts/dist packages/platform-artifacts/dist
COPY --from=builder /app/packages/run-view/dist packages/run-view/dist
COPY --from=builder /app/packages/applet-runtime/dist packages/applet-runtime/dist
COPY --from=builder /app/packages/integration-simulator/dist packages/integration-simulator/dist
COPY --from=builder /app/packages/oauth/dist packages/oauth/dist
COPY --from=builder /app/packages/ui-artifact-compiler/dist packages/ui-artifact-compiler/dist

COPY --from=builder /app/packages/server-runtime/dist packages/server-runtime/dist
COPY --from=builder /app/apps/server/dist apps/server/dist
COPY --from=builder /app/apps/aflow-orchestrator/dist apps/aflow-orchestrator/dist
COPY --from=builder /app/apps/aflow-executor-ai/dist apps/aflow-executor-ai/dist
COPY --from=builder /app/apps/aflow-executor-api/dist apps/aflow-executor-api/dist
COPY --from=builder /app/apps/aflow-executor-user/dist apps/aflow-executor-user/dist
COPY --from=builder /app/apps/aflow-executor-memory/dist apps/aflow-executor-memory/dist
COPY --from=builder /app/apps/aflow-executor-mock/dist apps/aflow-executor-mock/dist
COPY --from=builder /app/apps/aflow-executor-ui/dist apps/aflow-executor-ui/dist
COPY --from=builder /app/apps/aflow-executor-compute/dist apps/aflow-executor-compute/dist
COPY --from=builder /app/apps/aflow-executor-mcp/dist apps/aflow-executor-mcp/dist
COPY --from=builder /app/apps/aflow-mcp/dist apps/aflow-mcp/dist
COPY --from=builder /app/packages/web-product/dist packages/web-product/dist
COPY --from=builder /app/apps/web-local/.next apps/web-local/.next
# `next start` serves `public/` and reads `next.config.ts` at boot. Without
# them every static asset 404s and `compress: false` is lost — which buffers
# SSE through the BFF and makes a streaming session look stalled.
COPY --from=builder /app/apps/web-local/public apps/web-local/public
COPY --from=builder /app/apps/web-local/next.config.ts apps/web-local/next.config.ts
# Copy database migrations (needed at runtime for db:migrate)
COPY --from=builder /app/packages/database/src/migrations packages/database/src/migrations

# Copy production scripts (launcher + release migrations)
COPY --from=builder /app/scripts/prod-launcher.mjs scripts/
COPY --from=builder /app/scripts/release.mjs scripts/
# Ships so a key migration can run where the database is reachable — Cloud SQL
# is private-IP, so this cannot be driven from a workstation.
COPY --from=builder /app/scripts/rewrap-credentials.mjs scripts/

# Hosts that assign a port set $PORT; 8080 is Cloud Run's default
ENV PORT=8080

# Default profile — override via env var or command arg
ENV PHOENIX_PROFILE=web-core


# Drop root. /app stays root-owned and world-readable: the runtime only reads
# it, so nothing here needs to be writable, and leaving ownership alone keeps
# the image from carrying a second copy of the tree.
#
# This is a real reduction for `web-core` (the Cloud Run API), which is the
# internet-facing surface and mounts nothing privileged. It is NOT one for the
# `worker` profile, which bind-mounts the host Docker socket — reaching that
# socket is equivalent to root on the host whatever user holds it — so
# scripts/gcp-worker.sh overrides this back to root rather than implying a
# containment that isn't there. Removing the socket from the general worker is
# what would close that, and it is tracked separately in Plan 263 (SEC-08).
# The appliance's writable state. Created here, and owned by the runtime user,
# because a named volume takes its ownership from the mount point in the image:
# without this the volume arrives root-owned and a non-root process cannot
# write the instance secret it is supposed to generate on first boot.
# Every directory a named volume mounts at has to exist here first. A volume
# takes its ownership from the image's mount point, so one the image never
# created arrives owned by root and the non-root runtime cannot write the file
# it is supposed to generate on first boot.
RUN mkdir -p /var/lib/aflow/instance /var/lib/aflow/worker /var/lib/aflow/web /var/lib/aflow/payloads \
  /var/lib/aflow/redis /var/lib/aflow/host /var/lib/aflow/compute \
  && chown -R node:node /var/lib/aflow

USER node

# Entrypoint: the production launcher reads PHOENIX_PROFILE
CMD ["node", "scripts/prod-launcher.mjs"]

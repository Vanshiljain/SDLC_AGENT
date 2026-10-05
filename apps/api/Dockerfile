# syntax=docker/dockerfile:1.7
# Build context: repository root.
#   docker build -f apps/api/Dockerfile --target api    -t forgeline-api .
#   docker build -f apps/api/Dockerfile --target worker -t forgeline-worker .
#   docker build -f apps/api/Dockerfile --target migrate -t forgeline-migrate .
ARG BUILD_IMAGE=node:22-bookworm
ARG RUNTIME_IMAGE=gcr.io/distroless/nodejs22-debian12:nonroot
ARG DOCKER_CLI_IMAGE=docker:28-cli

# ─── Build: install, compile the workspace, produce a pruned production bundle ───
# The full Debian image already ships python3/make/g++ (native modules) and OpenSSL.
FROM ${BUILD_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm turbo run build --filter=@forgeline/api...
# Self-contained production install of the API and its workspace packages, plus the
# Prisma client generated above (Debian 12 / OpenSSL 3 — the same as the runtime image).
RUN pnpm deploy --legacy --filter=@forgeline/api --prod /out \
  && node infra/docker/copy-prisma-client.cjs packages/database /out

# ─── Migrate: one-shot job that applies migrations (SEED=true also seeds demo data) ───
FROM build AS migrate
WORKDIR /app/packages/database
ENV NODE_ENV=production
CMD ["sh", "-c", "pnpm exec prisma migrate deploy && if [ \"$SEED\" = \"true\" ]; then node dist/seed.js; fi"]

# ─── Runtime: API (HTTP + WebSocket). Distroless: no shell, no package manager, non-root. ───
FROM ${RUNTIME_IMAGE} AS api
ENV NODE_ENV=production APP_ROLE=api PORT=4000
WORKDIR /app
COPY --from=build --chown=nonroot:nonroot /out /app
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=5 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["dist/main.js"]

# ─── Runtime: worker (queues, schedulers, code-validation sandbox via Docker) ───
FROM ${DOCKER_CLI_IMAGE} AS dockercli
FROM api AS worker
ENV APP_ROLE=worker
# Docker CLI only (no daemon): sandboxes run as sibling containers through the mounted socket.
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
HEALTHCHECK NONE
CMD ["dist/main.js"]

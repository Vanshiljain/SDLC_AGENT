# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/web/Dockerfile .
ARG NODE_IMAGE=node:22-bookworm
ARG NGINX_IMAGE=nginx:1.27-alpine

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter=@forgeline/web... --filter=forgeline
# Same-origin by default: nginx proxies /api and /socket.io to the API.
ARG VITE_API_URL=
ENV VITE_API_URL=${VITE_API_URL}
RUN pnpm --filter=@forgeline/web exec vite build

FROM ${NGINX_IMAGE}
COPY infra/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
ENV API_UPSTREAM=api:4000
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1

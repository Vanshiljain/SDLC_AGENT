# Setup

This guide covers running Forgeline locally, with either the full Docker stack or a hot-reload
development setup, and every configuration variable.

## Requirements

| Tool           | Version                             | Used for                                       |
| -------------- | ----------------------------------- | ---------------------------------------------- |
| Node.js        | 22+                                 | API, workers, web build                        |
| pnpm           | 10.28 (Corepack: `corepack enable`) | Workspace package manager                      |
| Docker/Compose | 24+ / v2                            | Postgres 16, Redis 7, Qdrant 1.15; the sandbox |
| OpenAI API key | optional                            | Assistant and AI steps (see below)             |

## Option A: full stack in Docker

```bash
cp .env.example .env
```

Set these values in `.env`. The images run with `NODE_ENV=production`, and the API refuses to
start with the placeholder secrets or without secure cookies:

```bash
JWT_SECRET=$(openssl rand -base64 48)
JWT_REFRESH_SECRET=$(openssl rand -base64 48)
ENCRYPTION_KEYS=1:$(openssl rand -base64 32)
COOKIE_SECURE=true   # works on http://localhost (a secure context); use HTTPS anywhere else
```

Then:

```bash
SEED=true docker compose up -d --build   # SEED only on the first run
open http://localhost:8080
```

Compose starts:

1. Postgres, Redis and Qdrant.
2. A one-shot `migrate` container that applies migrations and optionally seeds.
3. The `api` and `worker` services.
4. nginx (`web`) on port 8080. It serves the SPA and proxies `/api` and `/socket.io`.

The `worker` container runs code validation (lint, typecheck, tests) in sibling Docker
containers. That needs two things: access to the Docker socket, and a sandbox directory that has
the same path on the host and in the container. The [deployment guide](DEPLOYMENT.md#sandbox)
explains this. If you do not want sandboxing, set `SANDBOX_DRIVER=disabled` and remove the two
worker volumes. Validation results then honestly report "not run".

## Option B: development (hot reload)

```bash
corepack enable
pnpm install
pnpm infra:up                         # Postgres :5432, Redis :6379, Qdrant :6333
cp .env.example .env                  # set the JWT secrets and ENCRYPTION_KEYS as above
pnpm db:deploy                        # apply migrations
pnpm build:packages                   # build shared packages (the API consumes their dist)
pnpm db:seed                          # demo workspace and accounts
pnpm dev                              # API :4000 (APP_ROLE=all), web :5173
```

Open http://localhost:5173 and sign in with a seeded account (see the README).

The Vite dev server proxies `/api` and `/socket.io` to `http://localhost:4000`, so the session
cookie stays same-origin. Leave `VITE_API_URL` empty unless the UI is served from a different
origin than the API.

To run validation for real while developing, set `SANDBOX_DRIVER=local`. Commands then run as
local processes with a minimal environment, and secrets are not inherited. Use it only on a
development machine, never in production.

### Developing without external services

After `pnpm build`, `pnpm --filter @forgeline/e2e stack` starts the built API on :4000 against **mock** Jira, GitHub,
Notion, DevOps and OpenAI-compatible services on :4010. With that stack running, `pnpm --filter
@forgeline/web dev` gives you a fully working product without any real accounts. The mocks keep
state, so you can inspect what was "created" at `http://localhost:4010/__state`.

## AI provider

Without `OPENAI_API_KEY`, Forgeline still works with these limits:

- Flows run and integrations work. Steps that need a model fail clearly with
  `AI provider is not configured`; they are never faked.
- The assistant matches actionable requests to Flow templates by keywords, and says that it is
  doing so.

| Variable                                                  | Purpose                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------ |
| `OPENAI_API_KEY`                                          | Enables the LLM and embeddings                               |
| `OPENAI_BASE_URL`                                         | Azure OpenAI or any OpenAI-compatible gateway                |
| `OPENAI_MODEL`                                            | Default chat model (orchestrator)                            |
| `OPENAI_MODEL_PLANNER` / `_CODER` / `_REVIEWER` / `_FAST` | Per-role overrides; empty means `OPENAI_MODEL`               |
| `OPENAI_EMBEDDING_MODEL` / `_DIMENSIONS`                  | Embeddings for RAG. Changing dimensions requires re-indexing |
| `OPENAI_TEMPERATURE`                                      | Empty means the model default (reasoning models ignore it)   |
| `OPENAI_TIMEOUT_MS` / `OPENAI_MAX_RETRIES`                | Client resilience                                            |

## Configuration reference

The API validates all configuration at startup and exits with a clear message when something is
wrong. JWT secrets shorter than 32 characters and encryption keys that do not decode to 32 bytes
are always rejected, and so is the `.env.example` encryption key placeholder. In
`NODE_ENV=production` the API additionally rejects:

- the `.env.example` JWT placeholders, or identical JWT secrets;
- `COOKIE_SECURE=false`;
- `SANDBOX_DRIVER=local`.

### Runtime

| Variable         | Default                 | Notes                                                                |
| ---------------- | ----------------------- | -------------------------------------------------------------------- |
| `NODE_ENV`       | `development`           | `production` enables the strict checks above                         |
| `APP_ROLE`       | `all`                   | `api`, `worker` or `all`                                             |
| `PORT`           | `4000`                  |                                                                      |
| `API_PUBLIC_URL` | `http://localhost:4000` | Used for OAuth callbacks and webhook URLs                            |
| `WEB_APP_URL`    | `http://localhost:5173` | Links in notifications, the Trello callback, CORS default            |
| `CORS_ORIGINS`   | `WEB_APP_URL`           | Comma-separated allow-list                                           |
| `TRUST_PROXY`    | `false`                 | Set `true` behind nginx or a load balancer (client IPs, rate limits) |
| `LOG_LEVEL`      | `info`                  | pino levels                                                          |

### Data stores

| Variable                                              | Notes                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------- |
| `DATABASE_URL`                                        | PostgreSQL (16 is tested)                                                         |
| `REDIS_URL`                                           | Redis (7 is tested); AOF persistence recommended                                  |
| `QUEUE_DRIVER`                                        | `bullmq` (durable) or `inline` (single process, tests only)                       |
| `QUEUE_NAME`                                          | Use different names for environments sharing one Redis                            |
| `QDRANT_URL` / `QDRANT_API_KEY` / `QDRANT_COLLECTION` | Vector store. Optional at runtime; knowledge features degrade with a clear status |

### Auth and security

| Variable                                          | Notes                                                                                                               |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `JWT_SECRET`, `JWT_REFRESH_SECRET`                | 32 or more characters each, and different from each other                                                           |
| `JWT_ACCESS_TTL_SECONDS` / `JWT_REFRESH_TTL_DAYS` | Defaults: 15 minutes and 14 days                                                                                    |
| `COOKIE_SECURE`                                   | `true` whenever the app is served over HTTPS                                                                        |
| `COOKIE_DOMAIN`                                   | Usually empty (host-only cookie)                                                                                    |
| `ENCRYPTION_KEYS`                                 | `version:base64(32 bytes)`, comma-separated. The highest version encrypts. See [Security](SECURITY.md#key-rotation) |
| `RATE_LIMIT_TTL_SECONDS` / `RATE_LIMIT_MAX`       | Per-client API rate limit (Redis-backed)                                                                            |
| `AUTH_RATE_LIMIT_MAX`                             | Per-minute limit on the register, login and accept-invite endpoints                                                 |

### Integrations

OAuth app credentials are optional. Every provider also supports token-based connections. See
[Integrations](INTEGRATIONS.md).

| Variable                                                                  | Notes                                              |
| ------------------------------------------------------------------------- | -------------------------------------------------- |
| `GITHUB_CLIENT_ID` / `_SECRET`, `GITHUB_API_URL`, `GITHUB_WEB_URL`        | GitHub OAuth App; Enterprise URLs                  |
| `JIRA_CLIENT_ID` / `_SECRET`, `ATLASSIAN_AUTH_URL`, `ATLASSIAN_API_URL`   | Atlassian OAuth 2.0 (3LO)                          |
| `NOTION_CLIENT_ID` / `_SECRET`, `NOTION_API_URL`                          | Notion public integration                          |
| `TRELLO_API_KEY`, `TRELLO_API_SECRET`, `TRELLO_API_URL`, `TRELLO_WEB_URL` | Trello authorization; the secret verifies webhooks |

### Sandbox and outbound HTTP

| Variable                                                  | Notes                                                                                      |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `SANDBOX_DRIVER`                                          | `docker` (production), `local` (development only) or `disabled`                            |
| `SANDBOX_DEFAULT_IMAGE`                                   | Image for validation commands, by default `node:22-bookworm`                               |
| `SANDBOX_WORKDIR`                                         | Where repositories are checked out                                                         |
| `SANDBOX_TIMEOUT_MS`, `SANDBOX_MEMORY_MB`, `SANDBOX_CPUS` | Resource limits per command                                                                |
| `SANDBOX_NETWORK`                                         | `bridge` allows dependency installation; `none` isolates fully                             |
| `OUTBOUND_ALLOW_PRIVATE_NETWORKS`                         | Allow health checks and HTTP steps to reach private IPs. Default `false` (SSRF protection) |
| `OUTBOUND_ALLOWED_HOSTS`                                  | Hostnames always allowed, even if they resolve privately                                   |

### Product and observability

| Variable                           | Notes                                                                  |
| ---------------------------------- | ---------------------------------------------------------------------- |
| `DEMO_MODE_ENABLED`                | Allows creating demo workspaces, whose Runs are simulated and labelled |
| `SWAGGER_ENABLED`                  | Serves OpenAPI at `/api/docs` and `/api/openapi.json`                  |
| `METRICS_ENABLED`, `METRICS_TOKEN` | Prometheus `/metrics`. Set a bearer token in production                |
| `SENTRY_DSN`                       | Optional error reporting                                               |
| `WORKER_CONCURRENCY`               | BullMQ concurrency per worker process                                  |

## Verifying the installation

```bash
curl -s localhost:4000/health/ready   # {"status":"ready","checks":{"database":…,"redis":…,"qdrant":…}}
```

Then go to _Integrations_ in the UI and use **Test connection** on each integration. Health
checks call the provider for real and report the actual error when one fails.

## Troubleshooting

| Symptom                                               | Cause and fix                                                                                                   |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| API exits with `Invalid configuration`                | The message names the variable. In production, secrets must not be placeholders                                 |
| Signed out on every reload                            | `COOKIE_SECURE=true` over plain HTTP on a host other than localhost, or the UI and API are on different origins |
| Validation step says "not run"                        | `SANDBOX_DRIVER=disabled`, or the worker cannot reach Docker (see Deployment)                                   |
| Health check blocked: "private network address"       | Set `OUTBOUND_ALLOWED_HOSTS` for internal environments                                                          |
| Two environments steal each other's jobs              | They share Redis. Give each a distinct `QUEUE_NAME`                                                             |
| Knowledge search says "embeddings are not configured" | `OPENAI_API_KEY` is missing (embeddings use the same provider)                                                  |

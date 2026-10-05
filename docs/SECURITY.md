# Security

Forgeline holds credentials for an organization's engineering systems and can act on them, up to
merging code and deploying to production. This page describes how that power is constrained.

## Reporting a vulnerability

Do not open a public issue. Email the maintainers with:

- a description of the issue;
- reproduction steps;
- the affected version or commit.

We acknowledge reports within three business days.

## Threat model

| Asset                       | Threats considered                                                                                        |
| --------------------------- | --------------------------------------------------------------------------------------------------------- |
| Integration credentials     | Database dump, log leakage, exposure to the browser, use by another tenant                                |
| Actions on external systems | A user or an AI exceeding their permissions; skipped approvals; duplicate side effects; replayed webhooks |
| User sessions               | XSS token theft, CSRF, refresh-token theft and replay, credential stuffing                                |
| Tenant data                 | Cross-organization reads through the API, realtime events, search or the vector store                     |
| The host                    | Untrusted repository code executed during validation; SSRF via health checks and HTTP steps               |

## Authentication and sessions

- **Passwords.** Argon2id (19 MiB memory, 2 iterations). Login takes the same time for unknown
  emails.
- **Access tokens.** HS256 JWT, 15 minutes by default, sent as `Authorization: Bearer`. The SPA
  keeps them **in memory only**.
- **Refresh tokens.**
  - Stored in an `HttpOnly; SameSite=Strict; Secure` cookie scoped to `/api/auth`. The database
    holds only their hash.
  - They rotate on every use and are grouped into families. Presenting an already-rotated token
    revokes the whole family, because that indicates theft.
- **CSRF.** The only cookie-authenticated endpoint is refresh. It requires a double-submit
  `x-csrf-token` header matching the `fl_csrf` cookie, and the cookies are `SameSite=Strict`.
- **Password change and logout.** A password change revokes every session. Logout revokes the
  current one.
- **Rate limits.** Redis-backed per-client limits apply everywhere. Register, login and invitation
  acceptance have stricter limits.
- **Accounts.** Disabled or deleted users are rejected at the guard and on the realtime socket,
  even with a still-valid access token.

## Authorization

- **RBAC.**
  - Organization roles: `OWNER`, `ADMIN`, `MEMBER` and `VIEWER`.
  - Project roles: `MAINTAINER`, `DEVELOPER` and `VIEWER`. They are unioned with the
    organization role within that project.
  - Both map to fine-grained permissions (`packages/shared/src/permissions.ts`). Code checks
    permissions, never roles.
- **Tenancy.** The guard resolves the active membership from `x-organization-id`. Every service
  query filters by that `organizationId`, and other tenants' resources return `404`. Realtime
  subscriptions are checked for ownership before a socket joins a room.
- **Denials are audited** (`permission.denied`). Only the route template is logged, never request
  bodies.
- **The AI cannot exceed the user.**
  - Agents and Flows act as the initiating user.
  - `ToolExecutor` re-checks the principal's permission for **every** tool call **at execution
    time**. A permission revoked mid-run stops the Run.
  - Scheduled and webhook-triggered Runs act as the Flow's creator or the integration's
    connector, under the same checks.
- **Gates cannot be bypassed.**
  - Approval policy is evaluated when a tool executes, from the tool's declared action. A Flow
    cannot remove gates by editing its steps.
  - Production deploys, PR merges and infrastructure destruction are locked to "always require
    approval".
  - Locked gates are four-eyes: the initiator cannot approve.
  - The approver must hold the gate's permission, for example `deploy:production`, and the
    gated action then runs with the approver's authority.
  - An unknown deploy environment is treated as production.

## Secrets

- **At rest.** Integration credentials and webhook secrets are encrypted with **AES-256-GCM**.
  Each value has a random 96-bit IV, and the owning record's ID is bound in as associated data,
  so a ciphertext cannot be moved to another integration. Keys are versioned.
- **In use.**
  - Credentials are decrypted only inside the API and worker process, by `CredentialVault`, to
    build provider clients.
  - Tools receive clients, never tokens.
  - No endpoint returns credentials. OAuth access and refresh tokens never reach the browser.
- **OAuth.**
  - `state` is random, single-use, expiring, and bound to the user and organization.
  - GitHub uses PKCE.
  - Refresh happens under a distributed lock, because providers rotate refresh tokens.
- **Redaction.**
  - Before anything is logged, audited or stored as tool input or output, values are redacted
    by key name (password, secret, token, authorization, cookie, signature, …) and by token
    shape: GitHub, Slack, OpenAI, Atlassian and Notion tokens, JWTs, Bearer and Basic
    credentials, and Slack webhook URLs.
  - pino additionally redacts auth headers and cookies.
- **Configuration.** The API refuses to start with weak or placeholder secrets. See
  [Setup](SETUP.md#configuration-reference).

### Key rotation

1. Generate a key: `openssl rand -base64 32`.
2. Append it with a higher version, for example `ENCRYPTION_KEYS=1:<old>,2:<new>`, and roll the
   API and workers.
3. New writes use version 2. Each existing credential is re-encrypted with the newest key the
   next time it is loaded.
4. To finish, run _Test connection_ on every integration, or wait for normal use. Once no rows
   reference version 1, remove it:
   `SELECT count(*) FROM "IntegrationCredential" WHERE "keyVersion" = 1;`

Rotate `JWT_SECRET` and `JWT_REFRESH_SECRET` by replacing them. All sessions end and users sign
in again.

## Untrusted code: the sandbox

Validation runs a repository's own lint, typecheck and test commands. Repository code is
untrusted. With `SANDBOX_DRIVER=docker`, each command runs in a fresh container with:

- `--read-only` root filesystem, plus a `tmpfs` for `/tmp`; only the workspace is writable;
- `--cap-drop ALL` and `--security-opt no-new-privileges`;
- `--pids-limit 512`, plus memory and CPU limits (`SANDBOX_MEMORY_MB`, `SANDBOX_CPUS`);
- a wall-clock timeout (`SANDBOX_TIMEOUT_MS`);
- network `SANDBOX_NETWORK`: `bridge` for dependency installation, or `none`;
- no Forgeline secrets in its environment. The worker downloads the repository as a GitHub
  tarball and extracts it with path traversal blocked. The token never enters the container.

The worker needs the Docker socket to start these containers, and **that socket is equivalent
to root on the host**. Run workers on dedicated hosts or VMs, or point them at a remote or
rootless Docker daemon. The `local` driver runs commands as plain processes, is for development
only, and is refused when `NODE_ENV=production`. With `disabled`, validation is reported as "not
run", never as passed.

## Outbound requests (SSRF)

Health checks, smoke tests, the `http.request` tool and URL ingestion use `safeFetch`, which:

- resolves the hostname and rejects private, loopback, link-local, CGNAT, multicast and
  IPv4-mapped private addresses, unless `OUTBOUND_ALLOW_PRIVATE_NETWORKS=true` or the host is in
  `OUTBOUND_ALLOWED_HOSTS`;
- checks the address actually connected to, at connect time, which defeats DNS rebinding;
- does not follow redirects; a `3xx` is returned to the caller as is;
- allows only `http` and `https` without embedded credentials, with a timeout (10 seconds by
  default), and truncates response bodies to 64 KB.

## Webhooks

- **Signatures.** Each provider's signature is verified in constant time (see
  [Integrations](INTEGRATIONS.md#webhooks)). DevOps signatures include a timestamp with a
  5-minute tolerance.
- **Deduplication.** Deliveries are deduplicated by delivery ID. Invalid deliveries are stored as
  `REJECTED` and audited.
- **Effects.** Webhooks can only start Flows through triggers or slash commands. Those Flows are
  subject to the same permission checks and gates as any other Run.

## Web application

- **API headers.** Helmet sets the API's headers, including `default-src 'none'` because the
  API serves no HTML.
- **nginx headers.** nginx serves the SPA with:
  - a CSP that allows `script-src 'self'` with no inline scripts and `frame-ancestors 'none'`;
  - `X-Frame-Options: DENY`, `nosniff`, a strict referrer policy and a restrictive
    `Permissions-Policy`.
- **CORS.** CORS is an explicit allow-list (`CORS_ORIGINS`) with credentials.
- **Markdown.** Markdown from agents and integrations is rendered without raw HTML. The JSON
  viewer escapes its content before highlighting.

## Audit trail

`AuditLog` is append-only. Each entry records:

- the actor: user, system, webhook or agent on behalf of a user;
- the action, resource, project and Run;
- the redacted input and output;
- the status: success, failure or denied;
- the IP, user agent and request ID.

Every tool execution, approval decision, Run start and end, integration change, membership
change and permission denial is recorded. Reading the log requires `audit:read`. It is exposed
in the UI with filters, and on each Run's _Audit_ tab.

## Demo mode

Demo workspaces (`isDemo`) never touch real systems:

- every tool call goes to the tool's simulator;
- tools without a simulator fail;
- every output is flagged `simulated`, and the UI labels Runs `DEMO`.

Demo mode is per workspace, not a global switch, so it cannot be enabled on a real workspace by
accident.

## Hardening checklist (production)

- [ ] `NODE_ENV=production`, `COOKIE_SECURE=true`, HTTPS end to end, and `TRUST_PROXY=true`
      behind the proxy.
- [ ] Unique secrets from a secrets manager. `ENCRYPTION_KEYS` is backed up: losing it means
      losing every stored credential.
- [ ] `SWAGGER_ENABLED=false`, or the docs are protected at the proxy. `METRICS_TOKEN` is set.
- [ ] Workers on isolated hosts with `SANDBOX_DRIVER=docker`, and `SANDBOX_NETWORK=none` if your
      builds allow it.
- [ ] `OUTBOUND_ALLOW_PRIVATE_NETWORKS=false`. Allow-list internal environment hosts explicitly.
- [ ] Postgres and Redis on private networks with authentication and encrypted backups.
- [ ] Seed accounts never created (`SEED=false`), or removed immediately.
- [ ] Per-project approval policies reviewed, with `deploy.staging` kept `required` where staging
      is shared.

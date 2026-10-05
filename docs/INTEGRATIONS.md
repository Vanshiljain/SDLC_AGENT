# Integrations

Forgeline works against real systems through **integrations**. These are organization-level
connections whose credentials are encrypted at rest and never sent to the browser. **Tools**
use them to act; see [Development](DEVELOPMENT.md#adding-a-tool) for how tools are built.

| Provider       | Connect with                                                            | Used for                                                                     |
| -------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| GitHub         | OAuth App (PKCE), or a personal access token (Enterprise URL supported) | Repositories, branches, commits, PRs, reviews, merges, code search, webhooks |
| GitHub Actions | Reuses the GitHub connection                                            | Dispatching CI and deploy workflows, awaiting runs, logs, re-runs            |
| Jira           | Atlassian OAuth 2.0 (3LO), or site URL + email + API token              | Tickets: create, read, search, update, transition, comment, attach           |
| Trello         | Trello authorization, or API key + token                                | Cards and boards: create, update, move, comment, attach                      |
| Notion         | Public integration OAuth, or an internal integration secret             | Publishing documentation pages; knowledge ingestion                          |
| DevOps (CI/CD) | API base URL + API token + request signing secret                       | Pipelines, deployments, rollbacks, environments (the contract is below)      |
| Slack          | Incoming webhook URL                                                    | Team notifications                                                           |

## Connecting

Go to **Integrations** in the UI (`integration:manage`). Each card shows which methods are
available. OAuth methods appear only when the server has the OAuth app credentials
(`*_CLIENT_ID` and `*_CLIENT_SECRET`, or `TRELLO_API_KEY`).

- **Token connections are verified before they are saved.** Forgeline calls the provider (for
  example `GET /user`, `GET /myself` or `GET /v1/health`), and a bad token is rejected with the
  provider's error.
- **OAuth.**
  - The flow's `state` is single-use, bound to the user and organization, and expires.
    GitHub uses PKCE.
  - Callback URL to register with the provider:
    `${API_PUBLIC_URL}/api/integrations/oauth/<provider>/callback`. For Trello it is
    `${WEB_APP_URL}/integrations/trello/callback`.
  - Scopes: GitHub `repo workflow read:user read:org`; Jira `read:jira-work write:jira-work
read:jira-user manage:jira-webhook offline_access`.
  - Refresh tokens rotate transparently before they expire.
- **Health.** _Test connection_ calls the provider for real and records the status and a message
  (the latency, or the provider's error). An integration with a failing status is shown as such, and
  steps that need it fail with that error. They are never simulated.
- **Disconnecting** deletes the stored credentials and deactivates the integration's webhooks.

### Project settings

Integrations belong to the organization. Projects choose how to use them, under _Project →
Settings_:

| Setting                                             | Meaning                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `ticketProvider`                                    | `JIRA` or `TRELLO`. The `ticket.*` tools route to it                                 |
| `jiraProjectKey`, `jiraIssueType`                   | Where tickets are created                                                            |
| `trelloBoardId`, `trelloListId`, `trelloDoneListId` | Trello board and lists                                                               |
| `cicdProvider`                                      | `CUSTOM_DEVOPS` or `GITHUB_ACTIONS`. The `devops.*` and `deploy.*` tools route to it |
| `notionParentPageId`                                | Parent page for generated documentation                                              |
| `slackChannel`                                      | Label shown in notifications                                                         |
| `approvalPolicy`                                    | Per-action `auto` or `required` overrides (locked actions are always required)       |

Each **repository** declares how to validate code: `installCommand`, `lintCommand`,
`typecheckCommand`, `testCommand`, `buildCommand`, an optional `sandboxImage`, and, for GitHub
Actions, `ciWorkflow` and `deployWorkflow`.

Each **environment** declares `type` (`DEVELOPMENT`, `STAGING` or `PRODUCTION`), `url`,
`healthCheckPath` and `smokeTests`. Forgeline runs the health checks and smoke tests itself, as
real HTTP probes, after every deploy. A failed probe triggers the rollback path.

## Demo workspaces

In a demo workspace, every tool with a `simulate()` implementation returns deterministic,
clearly labelled results (`simulated: true`, `mode: DEMO`). Links are `null` rather than
invented URLs. Tools without a simulator fail with "only available with real integrations".
Demo workspaces never use real credentials.

## Webhooks

`POST /api/webhooks/<provider>/<webhookId>`. Create a webhook with _Integration → Webhooks_ or
`POST /api/integrations/:id/webhooks`:

- For **GitHub** (with a repository) and **Trello** (with a board), Forgeline registers the
  webhook with the provider automatically.
- For **Jira** and **DevOps**, the response shows the URL and the signing secret **once**. You
  configure them in the provider yourself.

| Provider | Signature header                                  | Algorithm                                                                            | Delivery ID header               |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------------------ | -------------------------------- |
| GitHub   | `X-Hub-Signature-256`                             | `sha256=` + hex HMAC-SHA256(secret, raw body)                                        | `X-GitHub-Delivery`              |
| Jira     | `X-Hub-Signature`                                 | `sha256=` + hex HMAC-SHA256(secret, raw body)                                        | `X-Atlassian-Webhook-Identifier` |
| Trello   | `X-Trello-Webhook`                                | base64 HMAC-SHA1(`TRELLO_API_SECRET`, raw body + callback URL)                       | the action ID                    |
| DevOps   | `X-Forgeline-Signature` + `X-Forgeline-Timestamp` | `v1=` + hex HMAC-SHA256(secret, `${timestamp}.${raw body}`); timestamp within ±300 s | `X-Forgeline-Delivery`           |

Processing a delivery:

- Every comparison is constant-time.
- Invalid signatures are rejected (`401 INVALID_SIGNATURE`) and audited.
- Deliveries are deduplicated by `(webhook, deliveryId)`. A redelivery returns
  `{ status: "duplicate" }`.

Deliveries become events that **event triggers** match:

| Source | Event names                                                                                                      |
| ------ | ---------------------------------------------------------------------------------------------------------------- |
| GitHub | `github.<x-github-event>.<action>`, for example `github.pull_request.opened`                                     |
| Jira   | `jira.issue.created`, `jira.issue.updated`, …, plus `jira.issue.transitioned` (with `fromStatus` and `toStatus`) |
| Trello | `trello.<actionType>`, plus `trello.card.moved` (with `toList`)                                                  |
| DevOps | `devops.<body.event>`                                                                                            |

**Slash commands:**

- `/forgeline review` in a comment on a GitHub PR starts a review Run.
- `/forgeline implement`, `/forgeline plan` and `/forgeline spec` in a comment on a Jira issue
  start the matching Flow.

These Runs act as the user who connected the integration. Every tool call is still
permission-checked, and policy gates still apply.

## GitHub Actions as the CI/CD provider

With `cicdProvider: GITHUB_ACTIONS`, pipelines and deployments are `workflow_dispatch` runs:

```yaml
# .github/workflows/ci.yml (name configurable per repository via ciWorkflow)
on:
  workflow_dispatch:
    inputs:
      stages: { type: string, default: 'lint,build,test' }
      forgeline_ref: { type: string, required: false }
run-name: CI · ${{ inputs.forgeline_ref }} # lets Forgeline match its dispatch exactly
```

```yaml
# .github/workflows/deploy.yml (deployWorkflow)
on:
  workflow_dispatch:
    inputs:
      environment: { type: string, required: true }
      version: { type: string, required: true }
      ref: { type: string, required: false }
      forgeline_ref: { type: string, required: false }
      rollback: { type: string, default: 'false' }
run-name: Deploy ${{ inputs.environment }} · ${{ inputs.forgeline_ref }}
```

Without `run-name`, Forgeline takes the newest dispatched run of that workflow, which is
ambiguous when two Runs dispatch the same workflow within seconds.

The integration health check reports when the workflows are missing. Forgeline still runs the
health checks and smoke tests against the environment URL itself.

## Custom DevOps contract

Forgeline's CI/CD layer depends only on the `CiCdProvider` interface
(`packages/integrations/src/devops/cicd.ts`). To plug in your own platform, implement this REST
contract. The contract is what the `HttpDevOpsProvider` adapter speaks, and the e2e mock in
`e2e/mock-services/server.ts` is a working reference implementation.

### Request authentication

Every request carries:

| Header                  | Value                                                                                                             |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `Authorization`         | `Bearer <API token>`                                                                                              |
| `X-Forgeline-Timestamp` | Unix seconds                                                                                                      |
| `X-Forgeline-Signature` | `v1=` + hex(HMAC-SHA256(signing secret, `${timestamp}.${body}`)). The body is the exact raw JSON (`{}` for GET)   |
| `Idempotency-Key`       | On `POST /v1/pipelines`, `/v1/deployments` and `/rollback`. Repeating a key **must** return the original resource |
| `Content-Type`          | `application/json`                                                                                                |

Your service should:

- verify the signature in constant time;
- reject timestamps more than 5 minutes old;
- treat a repeated `Idempotency-Key` as a replay, not a new request.

Forgeline retries on `5xx`, on `429` (honouring `Retry-After`) and on network errors. It does
not retry other `4xx` responses.

### Endpoints

| Method and path                     | Request           | Response                                     |
| ----------------------------------- | ----------------- | -------------------------------------------- |
| `GET /v1/health`                    |                   | `{ status: "ok", version? }`                 |
| `POST /v1/pipelines`                | `PipelineRequest` | `PipelineRun`                                |
| `GET /v1/pipelines/:id`             |                   | `PipelineRun`                                |
| `GET /v1/pipelines/:id/logs?stage=` |                   | `text/plain` logs (one stage, or all)        |
| `POST /v1/pipelines/:id/cancel`     | `{}`              | any 2xx                                      |
| `POST /v1/pipelines/:id/retry`      | `{}`              | `PipelineRun` (new or restarted)             |
| `POST /v1/deployments`              | `DeployRequest`   | `DeploymentHandle`                           |
| `GET /v1/deployments/:id`           |                   | `DeploymentHandle`                           |
| `POST /v1/deployments/:id/rollback` | `RollbackRequest` | `DeploymentHandle` (the rollback deployment) |
| `GET /v1/environments?project=`     |                   | `{ environments: CiCdEnvironment[] }`        |

```ts
type RunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
type PipelineStage = 'lint' | 'build' | 'test' | 'security_scan' | 'artifact' | 'container_build' | 'image_scan';

interface PipelineRequest {
  project: string; // Forgeline project key, e.g. "AUTH"
  repository?: string; // "owner/name"
  ref: string;
  commitSha?: string;
  stages: PipelineStage[];
  idempotencyKey: string;
  variables?: Record<string, string>;
}

interface PipelineRun {
  id: string;
  status: RunStatus;
  url?: string | null;
  stages: {
    stage: string;
    status: RunStatus;
    startedAt?: string | null;
    completedAt?: string | null;
    summary?: string | null;
    url?: string | null;
  }[];
  artifact?: { ref: string; digest?: string | null } | null;
  image?: { ref: string; digest?: string | null; vulnerabilities?: { critical: number; high: number; medium: number; low: number } } | null;
}

interface DeployRequest {
  project: string;
  environment: string; // environment name in Forgeline, e.g. "staging"
  environmentType: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION';
  version: string;
  ref?: string;
  commitSha?: string;
  artifactRef?: string;
  strategy?: 'rolling' | 'blue_green' | 'canary' | 'recreate';
  idempotencyKey: string;
  config?: Record<string, unknown>;
}

interface DeploymentHandle {
  id: string;
  status: RunStatus;
  environment: string;
  version: string;
  url?: string | null;
  message?: string | null;
}

interface RollbackRequest {
  project: string;
  environment: string;
  deploymentId: string; // the deployment to roll back from
  targetVersion?: string; // version to restore (default: previous successful)
  targetRef?: string;
  idempotencyKey: string;
  config?: Record<string, unknown>;
}

interface CiCdEnvironment {
  name: string;
  type?: string;
  url?: string | null;
  currentVersion?: string | null;
}
```

How Forgeline uses the contract:

- Pipelines and deployments are **asynchronous**. Return immediately with `queued` or `running`.
  Forgeline polls `GET …/:id` with durable continuations, so a long deploy holds no worker and
  survives restarts.
- The pipeline's status and summary appear in the approval context, so approvers see CI
  results before a production deploy.
- A deployment reported `succeeded` is still verified with Forgeline's own health checks and
  smoke tests before the step completes.

### Events (optional)

Send events to the inbound webhook URL to drive event triggers. Sign them like requests
(`X-Forgeline-Timestamp`, `X-Forgeline-Signature`) and include `X-Forgeline-Delivery: <unique
id>`:

```json
{ "event": "deployment.failed", "id": "evt_123", "project": "AUTH", "environment": "production", "deploymentId": "dep_9" }
```

The example above triggers Flows listening for `devops.deployment.failed`.

# Development

How to work on the Vanshil's SDLC codebase. Start with [Setup](SETUP.md) to get a running
environment, and read [Architecture](ARCHITECTURE.md) for the big picture.

## Workspace

A pnpm + Turborepo monorepo. Packages build to `dist/` and the API consumes those builds.

The web app's Vite config and `tsconfig` alias `@forgeline/shared` to its source, so UI work
does not need a rebuild.

| Command                         | What it does                                                    |
| ------------------------------- | --------------------------------------------------------------- |
| `pnpm dev`                      | API (watch, `APP_ROLE=all`) and web (Vite) in parallel          |
| `pnpm build` / `build:packages` | Build everything, or only `packages/*`                          |
| `pnpm lint` / `typecheck`       | ESLint 9 (flat config) and `tsc --noEmit` in every package      |
| `pnpm test`                     | Unit tests in every package (Vitest; Jest in the API)           |
| `pnpm format` / `format:check`  | Prettier (print width 140)                                      |
| `pnpm db:migrate`               | Create and apply a migration from `schema.prisma` changes (dev) |
| `pnpm db:deploy` / `db:seed`    | Apply migrations / seed demo data                               |

Run a single package's tasks with a filter, for example
`pnpm --filter @forgeline/workflow-engine test`. To include dependencies, use
`pnpm turbo run build --filter=@forgeline/api...`.

When a shared package changes while `pnpm dev` is running, rebuild it
(`pnpm --filter @forgeline/shared build`). The API watcher then picks up the new `dist`.

## Conventions

- **TypeScript strict, no `any`.** Validate at boundaries:
  - DTOs with `class-validator` in controllers;
  - zod for tool inputs, Flow definitions and LLM structured output.
- **Business logic lives in services and tools**, never in controllers or React components.
  User-facing actions are commands in `packages/shared/src/commands.ts`, so chat, the palette,
  buttons and webhooks share one implementation.
- **Tenancy is not optional.** Every query on tenant-owned data filters by `organizationId` from
  the `AuthContext`. Controllers declare `@RequirePermissions(...)`, with `projectFrom` when the
  permission is project-scoped.
- **Errors are typed.** Services throw `AppException` (HTTP) and tools throw `ToolError` with a
  `kind` (`validation`, `auth`, `permission`, `not_found`, `conflict`, `rate_limit`, `network`,
  `external`, `timeout`, `not_configured`, …). The `kind` sets the default for whether to
  retry (`timeout`, `rate_limit`, `network`, `external` and `malformed_response` retry), and a
  tool can override it. Never catch an
  error and continue silently. Log it, record it on the step, or rethrow it.
- **Multi-row writes use `prisma.$transaction`.** The engine uses conditional updates
  (`WHERE status = expected`) so that duplicate deliveries are no-ops.
- **Honesty.** Results must reflect what ran. A skipped validation is `skipped` or "not run",
  never "passed". Demo runs are flagged `simulated`.
- **Secrets.** Credentials are read only through `CredentialVault` and `ConnectionResolver`.
  Never log tokens. `redact()` runs before anything reaches logs or the audit trail, but do not
  rely on it as your only defence.

## Adding a tool

Tools are the only way agents and Flows touch the outside world. Each tool is a `SdlcTool`
(`packages/integrations/src/core/tool.ts`):

```ts
export const jiraAddLabel = defineTool({
  name: 'jira.addLabel', // <provider>.<verb><Noun>; must be unique
  title: 'Add Jira label',
  description: 'Add a label to an issue. Safe to retry.', // the LLM and the builder read this
  category: 'jira',
  provider: 'JIRA',
  agent: 'planning',
  inputSchema: z.object({ issueKey: z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/), label: z.string().max(100) }),
  permission: 'ticket:write', // re-checked against the initiating user at execution time
  risk: 'write',
  sideEffects: true, // enables the idempotency ledger
  async execute(input, ctx) {
    const jira = await ctx.clients.jira(); // authenticated client, built from the encrypted vault
    const issue = await jira.getIssueAsText(input.issueKey);
    // Naturally idempotent: adding a label that is already present changes nothing.
    if (!issue.labels.includes(input.label)) await jira.updateIssue(input.issueKey, { labels: [...issue.labels, input.label] });
    return { output: { issueKey: input.issueKey }, summary: `Labelled ${input.issueKey} "${input.label}"` };
  },
  async simulate(input) {
    // Optional. Without it the tool is unavailable in demo workspaces, which is better than faking it.
    return { output: { issueKey: input.issueKey }, summary: `Would label ${input.issueKey}`, simulated: true };
  },
});
```

Checklist:

1. Export the tool from its provider's `tools.ts` array. `integrationTools` registers everything
   in `packages/integrations/src/index.ts`. Platform tools that need Nest services (`code.*`,
   `qa.run`, `deploy.*`, `ai.*`, `knowledge.retrieve`) register themselves with `ToolRegistry`
   in `onModuleInit` under `apps/api/src/sdlc` and `apps/api/src/knowledge`.
2. **Side effects must be idempotent.**
   - Use `idempotencyMarker(ctx)` or `ctx.idempotencyKey` to find before creating (a label,
     branch name, PR head or page marker).
   - The ledger covers retries. Find-before-create covers a crash between the external call and
     the ledger write.
3. Set `approvalAction` for anything that policy should gate (`pr.merge`, `deploy.environment`
   and similar). Do not rely on Flow authors adding approval steps.
4. Long-running work (CI runs, deployments) returns `continuation: { pollAfterMs, checkpoint }`
   instead of sleeping. Polling then survives restarts and does not hold a worker.
5. Test the tool against a mocked `fetch` (`packages/integrations/src/test-utils.ts`). Cover
   success, find-before-create on retry, and error classification.

The builder palette, the tool picker and the API's `GET /api/tools` read the registry, so a new
tool appears in them automatically.

## Adding a Flow template or command

- Templates live in `apps/api/src/workflows/flow-templates.ts`. `flow-templates.spec.ts`
  validates each one (DAG, tools, templates, expressions), so `pnpm --filter @forgeline/api test`
  catches mistakes.
- A command (`packages/shared/src/commands.ts`) points to a template and declares its inputs and
  permission. The palette, the assistant router and webhooks pick it up.

## Data model changes

1. Edit `packages/database/prisma/schema.prisma`.
2. Run `pnpm db:migrate --name <change>`. Commit the generated SQL under `prisma/migrations`.
3. If you added or changed an enum that is mirrored in `packages/shared/src/enums.ts`, update
   both. `enum-sync.spec.ts` fails when they drift.
4. Tenant-owned tables need `organizationId` plus an index on it.

## Frontend

- Routes are in `apps/web/src/app.tsx`, with pages lazily loaded from `src/pages`.
- Data access goes through TanStack Query hooks in `src/api/queries.ts`, with query keys in `qk`.
  Realtime events invalidate the relevant keys in `src/api/live.ts`, so pages stay live without
  polling.
- The design system lives in `src/components/ui`. Use the tokens (`bg-surface`, `text-fg-muted`,
  `text-accent`, `bg-ai-soft`, …) defined in `src/styles.css` rather than raw colours. Dark and
  light themes come from swapping the CSS variables.
- Gate UI with `useAuth().can('permission')`. This is a convenience only: the API enforces every
  permission regardless.
- The access token lives in memory only. The refresh token is an HttpOnly cookie that the browser
  manages. Never put tokens in `localStorage`.

## Testing

| Suite            | Command                                 | Needs                                |
| ---------------- | --------------------------------------- | ------------------------------------ |
| Unit (all)       | `pnpm test`                             | nothing                              |
| API integration  | `pnpm test:integration`                 | Postgres + Redis (`infra:up`)        |
| Acceptance (API) | `pnpm --filter @forgeline/e2e test:api` | built API, Postgres, Redis           |
| Acceptance (UI)  | `pnpm --filter @forgeline/e2e test:ui`  | as above, plus Chromium (Playwright) |

- **API integration tests** (`apps/api/test`) boot the real Nest app with `QUEUE_DRIVER=inline`
  against your database, and create isolated organizations per test. They cover auth and
  sessions, tenancy and RBAC, and engine behaviour: branching, approvals, rejection, retries,
  SSRF, crash recovery, the idempotency ledger, and permission revocation mid-run.
- **The acceptance scenario** (`e2e/scenario`) starts the built API with external services
  pointed at `e2e/mock-services`. Those mocks are stateful Jira, GitHub, Notion, DevOps and
  OpenAI-compatible endpoints. The GitHub mock serves a real repository tarball, so lint and
  tests run for real in the `local` sandbox. The scenario asserts what reached each service via
  `GET /__state`.
- **The Playwright test** (`e2e/ui`) drives the same story through the browser:
  1. an engineer asks Forge;
  2. they start the proposed Flow;
  3. they approve staging;
  4. they are blocked from approving the merge;
  5. the lead approves merge and production from the approval center.

The acceptance suites use their own ports and a dedicated `QUEUE_NAME`, so they can run while
`pnpm dev` is up.

## Debugging tips

- Every request has an `x-request-id`, which is echoed in error responses.
  `GET /api/workflow-executions/:id/logs` returns a Run's persisted logs, and the run page shows
  them per step.
- `LOG_LEVEL=debug` shows queue and engine decisions.
- `SWAGGER_ENABLED=true` serves OpenAPI at `/api/docs`.
- Stuck Run? The recovery sweep runs every 30 seconds and on boot. It re-enqueues expired step
  leases and Runs that are `RUNNING` with nothing in flight.

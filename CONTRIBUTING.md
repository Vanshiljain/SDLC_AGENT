# Contributing to Forgeline

Thank you for helping. This page explains how to propose a change. To get a working environment
and learn the code conventions, see [docs/SETUP.md](docs/SETUP.md) and
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Before you start

- **Bugs.** Open an issue with:
  - the steps to reproduce;
  - what you expected and what happened;
  - the version or commit;
  - relevant logs, with secrets removed.
- **Features.** Open an issue describing the problem first. Changes to the Flow language, the
  approval policy, permissions or the CI/CD contract affect every installation and need
  agreement before code.
- **Security issues.** Do not open an issue. Follow [docs/SECURITY.md](docs/SECURITY.md#reporting-a-vulnerability).

## Making a change

1. Branch from `main`.
2. Keep each pull request focused. A refactor and a feature are two PRs.
3. Add or update tests at the lowest layer that proves the behaviour:
   - pure logic → package unit tests;
   - API behaviour, permissions or tenancy → `apps/api/test` integration tests;
   - user-visible flows → the e2e scenario.
4. Update the docs in the same PR when behaviour, configuration or an API changes. That includes
   `.env.example` for new variables.
5. Run the same checks as CI:

   ```bash
   pnpm format:check
   pnpm turbo run lint typecheck test build
   pnpm test:integration                     # needs pnpm infra:up
   pnpm --filter @forgeline/e2e test:api     # needs the build and infrastructure
   ```

6. Open the PR. Describe what changed and why, how you tested it, and any migration or
   configuration impact.

## Non-negotiables

Reviewers reject changes that break these, whatever else the change does well:

- **No fake implementations.** Nothing may report work that did not happen: a "passed" test
  that did not run, a deployment that was not verified, a fabricated link. If something cannot
  run, say so in the result.
- **No authorization shortcuts.** Every side effect goes through `ToolExecutor`, which re-checks
  permissions and applies policy gates. Never call a provider client directly from a controller,
  an agent or a component.
- **No secrets outside the vault.** Do not log, return, persist unencrypted, or send to the
  browser any credential or token.
- **Tenancy on every query.** Filter tenant-owned data by `organizationId`.
- **Idempotent side effects.** New write tools need an idempotency strategy (ledger plus
  find-before-create) and tests for it.
- **Typed boundaries.** No `any`. DTOs and zod schemas validate input. Errors are typed and are
  never swallowed silently.
- **Demo stays separate.** Simulated behaviour lives only in a tool's `simulate()`, and its
  output is flagged.

## Commit messages

Use the imperative mood and keep the summary line to about 72 characters, for example "Add
Trello card move compensation". Explain the _why_ in the body when it is not obvious. Reference
issues as `#123` in the body.

## Database migrations

Generate migrations with `pnpm db:migrate --name <change>` and commit the SQL. Migrations must be
backwards-compatible with the previous release so that rolling deploys work: add before you
remove, and backfill in a separate step.

## Code review

Every PR needs one approving review. Changes to `approvals/`, `rbac/`, `common/auth`,
`common/crypto`, `tools/tool-executor.service.ts` or `webhooks/` need a second reviewer familiar
with the security model.

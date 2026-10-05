import { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import { defineTool, type AnySdlcTool, type ToolExecutionResult } from '../core/tool';

interface DispatchOutput {
  runId: number | null;
  url: string | null;
  status: string;
}
import { demoNumber, resolveRepo, summarizeLogs } from '../core/helpers';
import type { GhWorkflowRun, GitHubClient } from '../github/client';

const repoField = z.string().regex(/^[\w.-]+\/[\w.-]+$/).optional();
const SUCCESS_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

interface AwaitCheckpoint {
  phase: 'locate' | 'wait';
  since: string;
  runIds: number[];
  polls: number;
}

export interface CiRunSummary {
  conclusion: 'success' | 'failure' | 'cancelled' | 'none';
  runs: { id: number; name: string; url: string; status: string; conclusion: string | null }[];
  failedJobs: { name: string; url: string; logExcerpt: string }[];
}

async function collectFailures(gh: GitHubClient, owner: string, repo: string, runs: GhWorkflowRun[]): Promise<CiRunSummary['failedJobs']> {
  const failed: CiRunSummary['failedJobs'] = [];
  for (const run of runs.filter((r) => r.conclusion && !SUCCESS_CONCLUSIONS.has(r.conclusion))) {
    const { jobs } = await gh.listJobsForRun(owner, repo, run.id);
    for (const job of jobs.filter((j) => j.conclusion && !SUCCESS_CONCLUSIONS.has(j.conclusion)).slice(0, 5)) {
      let logExcerpt = '';
      try {
        logExcerpt = summarizeLogs(await gh.getJobLogs(owner, repo, job.id), 4000);
      } catch (err) {
        logExcerpt = `Logs unavailable: ${(err as Error).message}`;
      }
      failed.push({ name: `${run.name ?? 'workflow'} / ${job.name}`, url: job.html_url, logExcerpt });
    }
  }
  return failed;
}

function summarize(runs: GhWorkflowRun[]): CiRunSummary['conclusion'] {
  if (!runs.length) return 'none';
  if (runs.some((r) => r.conclusion === 'cancelled')) return 'cancelled';
  return runs.every((r) => r.conclusion && SUCCESS_CONCLUSIONS.has(r.conclusion)) ? 'success' : 'failure';
}

export const actionsDispatchWorkflow = defineTool({
  name: 'github_actions.dispatchWorkflow',
  title: 'Trigger workflow',
  description: 'Trigger a GitHub Actions workflow (workflow_dispatch) and resolve the created run.',
  category: 'github_actions',
  provider: 'GITHUB_ACTIONS',
  agent: 'release',
  inputSchema: z.object({
    repository: repoField,
    workflow: z.string().min(1).max(200).describe('Workflow file name (ci.yml) or id'),
    ref: z.string().min(1).max(200),
    inputs: z.record(z.string(), z.string()).default({}),
  }),
  permission: 'workflow:execute',
  risk: 'write',
  sideEffects: true,
  maxPollDurationMs: 5 * 60_000,
  async execute(input, ctx): Promise<ToolExecutionResult<DispatchOutput>> {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const cp = ctx.checkpoint as { since: string; polls: number } | undefined;
    const since = cp?.since ?? new Date(Date.now() - 5_000).toISOString();
    if (!cp) {
      await gh.dispatchWorkflow(repo.owner, repo.name, input.workflow, input.ref, input.inputs);
      ctx.logger.info(`Dispatched ${input.workflow} on ${input.ref}`);
    }
    const { workflow_runs } = await gh.listWorkflowRuns(repo.owner, repo.name, { workflow: input.workflow, event: 'workflow_dispatch', createdAfter: since.slice(0, 19) + 'Z' });
    const run = workflow_runs.filter((r) => r.created_at >= since).sort((a, b) => a.created_at.localeCompare(b.created_at))[0];
    if (!run) {
      return {
        output: { runId: null, url: null, status: 'requested' },
        summary: 'Waiting for GitHub to create the run…',
        continuation: { pollAfterMs: 5_000, checkpoint: { since, polls: (cp?.polls ?? 0) + 1 }, message: 'Locating workflow run' },
      };
    }
    return {
      output: { runId: run.id, url: run.html_url, status: run.status },
      summary: `Triggered ${input.workflow} → run ${run.id}`,
      externalResources: [{ provider: 'GITHUB_ACTIONS', type: 'CI_RUN', externalId: String(run.id), key: `run ${run.id}`, title: run.name ?? input.workflow, url: run.html_url, status: run.status }],
    };
  },
  async simulate(input, ctx): Promise<ToolExecutionResult<DispatchOutput>> {
    const id = demoNumber(ctx.idempotencyKey, 100000, 999999);
    return {
      simulated: true,
      output: { runId: id, url: null, status: 'queued' },
      summary: `[Simulated] Triggered ${input.workflow} → run ${id}`,
      externalResources: [{ provider: 'GITHUB_ACTIONS', type: 'CI_RUN', externalId: `demo-${id}-${ctx.idempotencyKey}`, key: `run ${id}`, title: input.workflow, status: 'queued' }],
    };
  },
});

export const actionsAwaitRuns = defineTool({
  name: 'github_actions.awaitRuns',
  title: 'Wait for CI',
  description:
    'Wait for GitHub Actions runs on a commit/branch (or a specific run) to finish, then report conclusion, failed jobs and log excerpts. Durable polling — survives restarts.',
  category: 'github_actions',
  provider: 'GITHUB_ACTIONS',
  agent: 'release',
  inputSchema: z.object({
    repository: repoField,
    ref: z.string().min(1).max(200).optional().describe('Commit SHA or branch'),
    runId: z.coerce.number().int().positive().optional(),
    workflow: z.string().optional(),
    /** If no runs appear within this window the result is conclusion "none". */
    discoveryTimeoutSeconds: z.number().int().min(10).max(1800).default(180),
  }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  maxPollDurationMs: 90 * 60_000,
  async execute(input, ctx): Promise<ToolExecutionResult<CiRunSummary>> {
    if (!input.ref && !input.runId) throw new ToolError('validation', 'Provide ref or runId');
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const cp: AwaitCheckpoint = (ctx.checkpoint as AwaitCheckpoint | undefined) ?? { phase: 'locate', since: new Date().toISOString(), runIds: input.runId ? [input.runId] : [], polls: 0 };

    let runs: GhWorkflowRun[];
    if (cp.runIds.length) {
      runs = await Promise.all(cp.runIds.map((id) => gh.getWorkflowRun(repo.owner, repo.name, id)));
    } else {
      const isSha = /^[0-9a-f]{40}$/.test(input.ref!);
      const res = await gh.listWorkflowRuns(repo.owner, repo.name, { workflow: input.workflow, ...(isSha ? { headSha: input.ref } : { branch: input.ref }) });
      // Latest attempt of each workflow for this ref.
      const latest = new Map<number, GhWorkflowRun>();
      for (const r of res.workflow_runs) {
        const prev = latest.get(r.workflow_id);
        if (!prev || prev.created_at < r.created_at) latest.set(r.workflow_id, r);
      }
      runs = [...latest.values()];
    }

    if (!runs.length) {
      const elapsed = (Date.now() - Date.parse(cp.since)) / 1000;
      if (elapsed < input.discoveryTimeoutSeconds) {
        return {
          output: { conclusion: 'none', runs: [], failedJobs: [] } satisfies CiRunSummary,
          summary: 'Waiting for CI runs to start…',
          continuation: { pollAfterMs: 15_000, checkpoint: { ...cp, polls: cp.polls + 1 }, message: 'Waiting for CI to start' },
        };
      }
      return { output: { conclusion: 'none', runs: [], failedJobs: [] } satisfies CiRunSummary, summary: `No CI runs found for ${input.ref} — CI did not execute` };
    }

    const pending = runs.filter((r) => r.status !== 'completed');
    const runSummaries = runs.map((r) => ({ id: r.id, name: r.name ?? 'workflow', url: r.html_url, status: r.status, conclusion: r.conclusion }));
    if (pending.length) {
      ctx.progress({ percent: Math.round(((runs.length - pending.length) / runs.length) * 100), message: `${pending.length} CI run(s) in progress` });
      return {
        output: { conclusion: 'none', runs: runSummaries, failedJobs: [] } satisfies CiRunSummary,
        summary: `${pending.length}/${runs.length} CI runs still running`,
        continuation: { pollAfterMs: 20_000, checkpoint: { phase: 'wait', since: cp.since, runIds: runs.map((r) => r.id), polls: cp.polls + 1 }, message: 'CI running' },
      };
    }

    const conclusion = summarize(runs);
    const failedJobs = conclusion === 'success' ? [] : await collectFailures(gh, repo.owner, repo.name, runs);
    return {
      output: { conclusion, runs: runSummaries, failedJobs } satisfies CiRunSummary,
      summary: conclusion === 'success' ? `CI passed (${runs.length} run${runs.length > 1 ? 's' : ''})` : `CI ${conclusion}: ${failedJobs.map((j) => j.name).join(', ') || 'see runs'}`,
      externalResources: runs.map((r) => ({ provider: 'GITHUB_ACTIONS' as const, type: 'CI_RUN' as const, externalId: String(r.id), key: `run ${r.id}`, title: r.name ?? 'workflow', url: r.html_url, status: r.conclusion ?? r.status })),
    };
  },
  async simulate(input, ctx): Promise<ToolExecutionResult<CiRunSummary>> {
    const polls = ((ctx.checkpoint as { polls?: number } | undefined)?.polls ?? 0) + 1;
    if (polls < 3) {
      return {
        simulated: true,
        output: { conclusion: 'none', runs: [], failedJobs: [] } satisfies CiRunSummary,
        summary: '[Simulated] CI running…',
        continuation: { pollAfterMs: 2_000, checkpoint: { polls }, message: 'CI running (simulated)' },
      };
    }
    const id = demoNumber(ctx.idempotencyKey, 100000, 999999);
    return {
      simulated: true,
      output: { conclusion: 'success', runs: [{ id, name: 'CI', url: '', status: 'completed', conclusion: 'success' }], failedJobs: [] } satisfies CiRunSummary,
      summary: `[Simulated] CI passed on ${input.ref ?? 'run'}`,
    };
  },
});

export const actionsGetJobLogs = defineTool({
  name: 'github_actions.getRunLogs',
  title: 'Get CI logs',
  description: 'Retrieve log excerpts of failed jobs of a workflow run.',
  category: 'github_actions',
  provider: 'GITHUB_ACTIONS',
  inputSchema: z.object({ repository: repoField, runId: z.coerce.number().int().positive() }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const run = await gh.getWorkflowRun(repo.owner, repo.name, input.runId);
    const { jobs } = await gh.listJobsForRun(repo.owner, repo.name, input.runId);
    const failedJobs = await collectFailures(gh, repo.owner, repo.name, [run]);
    return {
      output: { status: run.status, conclusion: run.conclusion, jobs: jobs.map((j) => ({ id: j.id, name: j.name, status: j.status, conclusion: j.conclusion })), failedJobs },
      summary: `Run ${run.id}: ${run.conclusion ?? run.status}, ${failedJobs.length} failed job(s)`,
    };
  },
});

export const actionsRerunWorkflow = defineTool({
  name: 'github_actions.rerunWorkflow',
  title: 'Retry workflow',
  description: 'Re-run a workflow run (optionally only failed jobs).',
  category: 'github_actions',
  provider: 'GITHUB_ACTIONS',
  inputSchema: z.object({ repository: repoField, runId: z.coerce.number().int().positive(), failedOnly: z.boolean().default(true) }),
  permission: 'workflow:execute',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    await gh.rerunWorkflow(repo.owner, repo.name, input.runId, input.failedOnly);
    return { output: { runId: input.runId, rerun: true }, summary: `Re-running ${input.failedOnly ? 'failed jobs of ' : ''}run ${input.runId}` };
  },
});

export const githubActionsTools: AnySdlcTool[] = [actionsDispatchWorkflow, actionsAwaitRuns, actionsGetJobLogs, actionsRerunWorkflow];

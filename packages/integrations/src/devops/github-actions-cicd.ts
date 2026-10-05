import { ToolError } from '@forgeline/shared';
import type { GitHubClient, GhWorkflowRun } from '../github/client';
import type {
  CiCdEnvironment,
  CiCdProvider,
  DeployRequest,
  DeploymentHandle,
  PipelineRequest,
  PipelineRun,
  RollbackRequest,
  RunStatus,
  StageResult,
} from './cicd';

/**
 * CiCdProvider backed by GitHub Actions workflow_dispatch.
 *
 * The repository must define a CI workflow (default `ci.yml`) and a deploy
 * workflow (default `deploy.yml`) that accept the documented inputs:
 *   ci.yml:     stages, forgeline_ref
 *   deploy.yml: environment, version, ref, forgeline_ref, rollback
 * Provider ids are "<workflowRunId>" (resolved after dispatch). Setting
 * `run-name: ... ${{ inputs.forgeline_ref }}` lets dispatches be matched exactly.
 */
export interface GitHubActionsCiCdOptions {
  owner: string;
  repo: string;
  ciWorkflow?: string;
  deployWorkflow?: string;
  defaultRef?: string;
}

function mapStatus(run: GhWorkflowRun): RunStatus {
  if (run.status !== 'completed') return run.status === 'in_progress' ? 'running' : 'queued';
  if (run.conclusion === 'success') return 'succeeded';
  if (run.conclusion === 'cancelled') return 'cancelled';
  return 'failed';
}

export class GitHubActionsCiCdProvider implements CiCdProvider {
  readonly name = 'GitHub Actions';
  readonly kind = 'GITHUB_ACTIONS' as const;

  constructor(
    private readonly gh: GitHubClient,
    private readonly options: GitHubActionsCiCdOptions,
  ) {}

  private get ci() {
    return this.options.ciWorkflow ?? 'ci.yml';
  }
  private get deployWf() {
    return this.options.deployWorkflow ?? 'deploy.yml';
  }

  async healthCheck() {
    const { workflows } = await this.gh.listWorkflows(this.options.owner, this.options.repo);
    const names = workflows.map((w) => w.path.split('/').pop());
    const missing = [this.ci, this.deployWf].filter((w) => !names.includes(w));
    return {
      ok: missing.length === 0,
      message: missing.length ? `Missing workflows: ${missing.join(', ')}` : `${workflows.length} workflows available`,
    };
  }

  /** Dispatch and resolve the run created by this dispatch (bounded wait). */
  private async dispatchAndFind(workflow: string, ref: string, inputs: Record<string, string>): Promise<GhWorkflowRun> {
    const since = new Date(Date.now() - 5_000).toISOString();
    await this.gh.dispatchWorkflow(this.options.owner, this.options.repo, workflow, ref, inputs);
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 1_000 : 3_000));
      const { workflow_runs } = await this.gh.listWorkflowRuns(this.options.owner, this.options.repo, {
        workflow,
        event: 'workflow_dispatch',
        createdAfter: since.slice(0, 19) + 'Z',
      });
      const recent = workflow_runs.filter((r) => r.created_at >= since);
      // Workflows that set `run-name` to include inputs.forgeline_ref are matched exactly, so
      // concurrent dispatches of the same workflow cannot be confused; otherwise the newest run wins.
      const match = recent.find((r) => Boolean(inputs.forgeline_ref) && r.display_title?.includes(inputs.forgeline_ref!)) ?? recent[0];
      if (match) return match;
    }
    throw new ToolError('external', `Dispatched ${workflow} but no run appeared within 60s`, { provider: 'github_actions' });
  }

  private async toPipeline(run: GhWorkflowRun): Promise<PipelineRun> {
    const { jobs } = await this.gh.listJobsForRun(this.options.owner, this.options.repo, run.id);
    const stages: StageResult[] = jobs.map((j) => ({
      stage: j.name,
      status:
        j.status !== 'completed'
          ? j.status === 'in_progress'
            ? 'running'
            : 'queued'
          : j.conclusion === 'success' || j.conclusion === 'skipped'
            ? 'succeeded'
            : j.conclusion === 'cancelled'
              ? 'cancelled'
              : 'failed',
      startedAt: j.started_at ?? null,
      completedAt: j.completed_at ?? null,
      url: j.html_url,
    }));
    return { id: String(run.id), status: mapStatus(run), url: run.html_url, stages };
  }

  async startPipeline(req: PipelineRequest): Promise<PipelineRun> {
    const run = await this.dispatchAndFind(this.ci, req.ref, { stages: req.stages.join(','), forgeline_ref: req.idempotencyKey });
    return this.toPipeline(run);
  }
  async getPipeline(id: string) {
    return this.toPipeline(await this.gh.getWorkflowRun(this.options.owner, this.options.repo, Number(id)));
  }
  async getPipelineLogs(id: string, stage?: string) {
    const { jobs } = await this.gh.listJobsForRun(this.options.owner, this.options.repo, Number(id));
    const selected = stage ? jobs.filter((j) => j.name === stage) : jobs.filter((j) => j.conclusion && j.conclusion !== 'success');
    const logs = await Promise.all(
      selected.slice(0, 5).map(async (j) => `### ${j.name}\n${await this.gh.getJobLogs(this.options.owner, this.options.repo, j.id)}`),
    );
    return logs.join('\n\n');
  }
  async cancelPipeline(id: string) {
    await this.gh.cancelWorkflowRun(this.options.owner, this.options.repo, Number(id));
  }
  async retryPipeline(id: string) {
    await this.gh.rerunWorkflow(this.options.owner, this.options.repo, Number(id), true);
    return this.getPipeline(id);
  }

  async deploy(req: DeployRequest): Promise<DeploymentHandle> {
    const run = await this.dispatchAndFind(this.deployWf, req.ref ?? this.options.defaultRef ?? 'main', {
      environment: req.environment,
      version: req.version,
      ref: req.commitSha ?? req.ref ?? '',
      forgeline_ref: req.idempotencyKey,
      rollback: 'false',
    });
    return { id: String(run.id), status: mapStatus(run), environment: req.environment, version: req.version, url: run.html_url };
  }
  async getDeployment(id: string): Promise<DeploymentHandle> {
    const run = await this.gh.getWorkflowRun(this.options.owner, this.options.repo, Number(id));
    return { id, status: mapStatus(run), environment: run.display_title ?? '', version: run.head_sha.slice(0, 7), url: run.html_url };
  }
  async rollback(req: RollbackRequest): Promise<DeploymentHandle> {
    if (!req.targetVersion && !req.targetRef) {
      throw new ToolError('validation', 'Rollback via GitHub Actions requires a target version or ref', { retryable: false });
    }
    const run = await this.dispatchAndFind(this.deployWf, this.options.defaultRef ?? 'main', {
      environment: req.environment,
      version: req.targetVersion ?? '',
      ref: req.targetRef ?? '',
      forgeline_ref: req.idempotencyKey,
      rollback: 'true',
    });
    return {
      id: String(run.id),
      status: mapStatus(run),
      environment: req.environment,
      version: req.targetVersion ?? req.targetRef ?? '',
      url: run.html_url,
    };
  }
  async listEnvironments(): Promise<CiCdEnvironment[]> {
    const res = await this.gh.listEnvironments(this.options.owner, this.options.repo);
    return (res?.environments ?? []).map((e) => ({ name: e.name, url: e.html_url }));
  }
}

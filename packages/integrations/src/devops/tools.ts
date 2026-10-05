import { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import { defineTool, type AnySdlcTool } from '../core/tool';
import { demoNumber, summarizeLogs } from '../core/helpers';
import { isTerminalRunStatus, PIPELINE_STAGES, type PipelineRun, type RunStatus, type StageResult } from './cicd';
import type { ToolExecutionResult } from '../core/tool';

export interface PipelineToolOutput {
  runId: string;
  status: RunStatus;
  url: string | null;
  stages: StageResult[];
  artifact: PipelineRun['artifact'];
  image: PipelineRun['image'];
  logsExcerpt: string | null;
  failedStages?: string[];
}

/**
 * Provider-neutral pipeline tools (build/test/lint/security/artifact/container/image scan).
 * Deployment, rollback, health and smoke tools live in the API (they persist Deployment records).
 */
export const devopsRunPipeline = defineTool({
  name: 'devops.runPipeline',
  title: 'Run CI/CD pipeline',
  description: 'Run pipeline stages (lint, build, test, security_scan, artifact, container_build, image_scan) on the configured CI/CD provider and wait for the result.',
  category: 'devops',
  provider: 'CUSTOM_DEVOPS',
  agent: 'release',
  inputSchema: z.object({
    ref: z.string().min(1).max(200),
    commitSha: z.string().optional(),
    stages: z.array(z.enum(PIPELINE_STAGES)).min(1).default(['lint', 'build', 'test', 'security_scan', 'artifact']),
    variables: z.record(z.string(), z.string()).default({}),
  }),
  permission: 'workflow:execute',
  risk: 'write',
  sideEffects: true,
  maxPollDurationMs: 2 * 3_600_000,
  async execute(input, ctx): Promise<ToolExecutionResult<PipelineToolOutput>> {
    const cicd = await ctx.clients.cicd();
    const cp = ctx.checkpoint as { runId: string } | undefined;
    let run: PipelineRun;
    if (!cp) {
      run = await cicd.startPipeline({
        project: ctx.project?.slug ?? 'default',
        repository: ctx.project?.repository?.fullName,
        ref: input.ref,
        commitSha: input.commitSha,
        stages: input.stages,
        idempotencyKey: ctx.idempotencyKey,
        variables: input.variables,
      });
      ctx.logger.info(`Started pipeline ${run.id} on ${cicd.name}`);
    } else {
      run = await cicd.getPipeline(cp.runId);
    }
    const done = run.stages.filter((s) => isTerminalRunStatus(s.status)).length;
    ctx.progress({ percent: run.stages.length ? Math.round((done / run.stages.length) * 100) : undefined, message: `${cicd.name}: ${run.status}` });
    const resource = { provider: cicd.kind, type: 'CI_RUN' as const, externalId: run.id, key: `pipeline ${run.id}`, title: `Pipeline ${input.ref}`, url: run.url ?? undefined, status: run.status };
    if (!isTerminalRunStatus(run.status)) {
      return {
        output: { runId: run.id, status: run.status, url: run.url ?? null, stages: run.stages, artifact: null, image: null, logsExcerpt: null },
        summary: `Pipeline ${run.id} ${run.status}`,
        externalResources: [resource],
        continuation: { pollAfterMs: 10_000, checkpoint: { runId: run.id }, message: `Pipeline ${run.status}` },
      };
    }
    let logsExcerpt: string | null = null;
    if (run.status !== 'succeeded') {
      try {
        logsExcerpt = summarizeLogs(await cicd.getPipelineLogs(run.id), 6000);
      } catch (err) {
        logsExcerpt = `Logs unavailable: ${(err as Error).message}`;
      }
    }
    const failedStages = run.stages.filter((s) => s.status === 'failed').map((s) => s.stage);
    return {
      output: { runId: run.id, status: run.status, url: run.url ?? null, stages: run.stages, artifact: run.artifact ?? null, image: run.image ?? null, logsExcerpt, failedStages },
      summary: run.status === 'succeeded' ? `Pipeline passed: ${run.stages.map((s) => s.stage).join(' → ')}` : `Pipeline ${run.status}${failedStages.length ? ` at ${failedStages.join(', ')}` : ''}`,
      externalResources: [resource],
    };
  },
  async simulate(input, ctx): Promise<ToolExecutionResult<PipelineToolOutput>> {
    const polls = ((ctx.checkpoint as { polls?: number } | undefined)?.polls ?? 0) + 1;
    const id = `demo-${demoNumber(ctx.idempotencyKey, 1000, 9999)}`;
    const stages = input.stages.map((stage, i) => ({ stage, status: (i < polls ? 'succeeded' : i === polls ? 'running' : 'queued') as PipelineRun['status'] }));
    if (polls < input.stages.length) {
      return {
        simulated: true,
        output: { runId: id, status: 'running', url: null, stages, artifact: null, image: null, logsExcerpt: null },
        summary: `[Simulated] Pipeline running (${input.stages[polls]})`,
        continuation: { pollAfterMs: 1_500, checkpoint: { polls }, message: 'Pipeline running (simulated)' },
      };
    }
    return {
      simulated: true,
      output: { runId: id, status: 'succeeded', url: null, stages: input.stages.map((stage) => ({ stage, status: 'succeeded' as const })), artifact: { ref: `demo-artifact:${input.ref}` }, image: null, logsExcerpt: null, failedStages: [] },
      summary: `[Simulated] Pipeline passed: ${input.stages.join(' → ')}`,
    };
  },
});

export const devopsGetLogs = defineTool({
  name: 'devops.getPipelineLogs',
  title: 'Get pipeline logs',
  description: 'Fetch logs for a pipeline run (optionally one stage).',
  category: 'devops',
  provider: 'CUSTOM_DEVOPS',
  inputSchema: z.object({ runId: z.string().min(1), stage: z.string().optional() }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const cicd = await ctx.clients.cicd();
    const logs = await cicd.getPipelineLogs(input.runId, input.stage);
    return { output: { logs: summarizeLogs(logs, 20_000) }, summary: `Fetched logs for ${input.runId}` };
  },
});

export const devopsListEnvironments = defineTool({
  name: 'devops.listEnvironments',
  title: 'List environments',
  description: 'List deployment environments known to the CI/CD provider.',
  category: 'devops',
  provider: 'CUSTOM_DEVOPS',
  inputSchema: z.object({}),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(_input, ctx) {
    if (!ctx.project) throw new ToolError('validation', 'A project is required');
    const cicd = await ctx.clients.cicd();
    const environments = await cicd.listEnvironments(ctx.project.slug);
    return { output: { environments }, summary: `${environments.length} environment(s)` };
  },
});

export const devopsTools: AnySdlcTool[] = [devopsRunPipeline, devopsGetLogs, devopsListEnvironments];

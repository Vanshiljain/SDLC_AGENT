import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@forgeline/database';
import { failureAnalysisSchema, qaTestPlanSchema, type QATestPlan } from '@forgeline/ai';
import { defineLooseTool, type ToolExecutionContext } from '@forgeline/integrations';
import { ToolError, type QARunStatus } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventBus } from '../events/event-bus.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { AgentTaskRunner, forPrompt } from './agent-task-runner.service';
import { SandboxService } from './sandbox/sandbox.service';
import { failureExcerpt, parseTestSummary, type StoredFile } from './code/code-utils';

/**
 * QA agent. Generates test cases from requirements, adds generated automated
 * tests to an isolated workspace, runs the suite, and analyses failures.
 * Status is derived from real runner exit codes and parsed counts; when the
 * suite cannot run the status is SKIPPED — never PASSED.
 */
@Injectable()
export class QaTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
    private readonly runner: AgentTaskRunner,
    private readonly sandbox: SandboxService,
    private readonly events: EventBus,
  ) {}

  async run(
    input: { ref?: string | null; requirement?: string | null; codeGenerationId?: string | null; acceptanceCriteria?: string[] | null },
    ctx: ToolExecutionContext,
  ) {
    const repo = ctx.project?.repository;
    if (!repo || !ctx.project)
      throw new ToolError('not_configured', 'QA requires a repository linked to the project', { retryable: false });
    const ref = input.ref || repo.defaultBranch;
    const cg = input.codeGenerationId
      ? await this.prisma.codeGeneration.findFirst({ where: { id: input.codeGenerationId, organizationId: ctx.organizationId } })
      : null;
    const changed = (cg?.files as unknown as StoredFile[] | undefined) ?? [];

    const run = await this.prisma.qATestRun.create({
      data: {
        organizationId: ctx.organizationId,
        projectId: ctx.project.id,
        repositoryId: repo.id,
        executionId: ctx.executionId ?? null,
        type: 'REGRESSION',
        status: 'RUNNING',
        title: `QA · ${ref}`,
        ref,
        commitSha: cg?.commitSha ?? null,
        startedAt: new Date(),
        command: repo.settings.testCommand ?? null,
      },
    });
    await this.events.publish({
      type: 'qa.started',
      organizationId: ctx.organizationId,
      projectId: ctx.project.id,
      executionId: ctx.executionId,
      data: { qaRunId: run.id, ref },
    });

    let plan: QATestPlan | null = null;
    if (input.requirement || changed.length) {
      const { output } = await this.runner.structured({
        ctx,
        agent: 'qa',
        task: 'Derive test cases',
        prompt: 'qaPlan',
        variables: {
          requirement: forPrompt(
            `${input.requirement ?? cg?.requirement ?? ''}\n\nAcceptance criteria:\n${(input.acceptanceCriteria ?? []).map((c) => `- ${c}`).join('\n')}`,
            8000,
          ),
          changes: forPrompt(
            changed
              .filter((f) => f.content)
              .map((f) => `=== ${f.path} ===\n${(f.content ?? '').slice(0, 6000)}`)
              .join('\n\n'),
            60_000,
          ),
          conventions: forPrompt(
            {
              testCommand: repo.settings.testCommand,
              frameworkHints: changed.filter((f) => /\.(spec|test)\./.test(f.path)).map((f) => f.path),
            },
            2000,
          ),
        },
        schema: qaTestPlanSchema,
        schemaName: 'qa_test_plan',
        role: 'coder',
        summarize: (p) => `${p.testCases.length} test case(s), ${p.automatedTests.length} automated test file(s)`,
      });
      plan = output;
    }

    let status: QARunStatus = 'SKIPPED';
    let summary: string;
    let counts = { total: 0, passed: 0, failed: 0, skipped: 0, parsed: false };
    let outputText: string | null = null;
    let analysis: unknown = null;
    let durationMs = 0;

    if (!this.sandbox.enabled || !repo.settings.testCommand) {
      summary = !this.sandbox.enabled
        ? `Generated ${plan?.testCases.length ?? 0} test case(s); execution skipped — sandbox disabled`
        : 'No test command configured for this repository; tests not executed';
    } else {
      const gh = await ctx.clients.github();
      const ws = await this.sandbox.createWorkspace(gh, repo.owner, repo.name, ref, ctx.signal);
      try {
        const generated = (plan?.automatedTests ?? []).filter((t) => !t.path.includes('..') && !t.path.startsWith('/'));
        await this.sandbox.applyChanges(
          ws,
          generated.map((t) => ({ path: t.path, content: t.content })),
        );
        if (repo.settings.installCommand) {
          const install = await this.sandbox.run(ws, repo.settings.installCommand, {
            image: repo.settings.sandboxImage,
            signal: ctx.signal,
          });
          if (install.exitCode !== 0) {
            status = 'ERROR';
            outputText = failureExcerpt(install.output);
          }
        }
        if (status !== 'ERROR') {
          ctx.progress({ message: 'Running test suite…' });
          const res = await this.sandbox.run(ws, repo.settings.testCommand, { image: repo.settings.sandboxImage, signal: ctx.signal });
          durationMs = res.durationMs;
          counts = parseTestSummary(res.output);
          outputText = res.exitCode === 0 ? res.output.slice(-4000) : failureExcerpt(res.output, 12_000);
          status = res.timedOut ? 'ERROR' : res.exitCode === 0 ? 'PASSED' : 'FAILED';
          // A zero exit with a parsed failure count is still a failure.
          if (status === 'PASSED' && counts.failed > 0) status = 'FAILED';
        }
      } finally {
        await ws.dispose();
      }
      if (status === 'FAILED' || status === 'ERROR') {
        const { output } = await this.runner.structured({
          ctx,
          agent: 'qa',
          task: 'Analyse QA failures',
          prompt: 'qaAnalyzeFailure',
          variables: {
            change: forPrompt({ requirement: input.requirement, files: changed.map((f) => f.path) }, 3000),
            output: forPrompt(outputText, 16_000),
          },
          schema: failureAnalysisSchema,
          schemaName: 'failure_analysis',
          role: 'reviewer',
          summarize: (a) => `${a.category}: ${a.rootCause}`,
        });
        analysis = output;
      }
      summary =
        status === 'PASSED'
          ? `QA passed${counts.parsed ? `: ${counts.passed}/${counts.total} tests` : ''}${plan ? ` · ${plan.testCases.length} cases derived` : ''}`
          : status === 'FAILED'
            ? `QA failed${counts.parsed ? `: ${counts.failed} failing of ${counts.total}` : ''}${analysis ? ` — ${(analysis as { rootCause: string }).rootCause.slice(0, 160)}` : ''}`
            : `QA could not run: ${(outputText ?? 'unknown error').split('\n')[0]?.slice(0, 160)}`;
    }

    const updated = await this.prisma.qATestRun.update({
      where: { id: run.id },
      data: {
        status,
        total: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        durationMs,
        output: outputText,
        testCases: (plan?.testCases ?? []) as unknown as Prisma.InputJsonValue,
        failures: (status === 'FAILED' ? [{ output: outputText }] : []) as Prisma.InputJsonValue,
        analysis: (analysis ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: new Date(),
      },
    });
    await this.events.publish({
      type: 'qa.completed',
      organizationId: ctx.organizationId,
      projectId: ctx.project.id,
      executionId: ctx.executionId,
      data: { qaRunId: run.id, status, passed: counts.passed, failed: counts.failed, total: counts.total },
    });
    const report = [
      `# QA report · ${ref}`,
      `**Status:** ${status} · ${summary}`,
      plan
        ? `## Test cases\n| ID | Title | Type | Priority |\n|---|---|---|---|\n${plan.testCases.map((t) => `| ${t.id} | ${t.title} | ${t.type} | ${t.priority} |`).join('\n')}`
        : '',
      plan?.automatedTests.length
        ? `## Generated automated tests\n${plan.automatedTests.map((t) => `- \`${t.path}\` — ${t.description}`).join('\n')}`
        : '',
      analysis ? `## Root cause analysis\n${forPrompt(analysis, 3000)}` : '',
      outputText && status !== 'PASSED' ? `## Output\n\`\`\`\n${outputText.slice(0, 8000)}\n\`\`\`` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return {
      output: {
        qaRunId: updated.id,
        status,
        total: counts.total,
        passed: counts.passed,
        failed: counts.failed,
        skipped: counts.skipped,
        testCases: plan?.testCases.length ?? 0,
        summary,
        analysis,
      },
      summary,
      artifacts: [{ type: 'TEST_REPORT' as const, title: `QA report · ${ref}`, content: report, data: { qaRunId: updated.id } }],
    };
  }

  onModuleInit(): void {
    const self = this;
    this.registry.register(
      defineLooseTool({
        name: 'qa.run',
        title: 'Run QA',
        description: 'Derive test cases from requirements, generate automated tests, run the suite in a sandbox and analyse failures.',
        category: 'quality',
        provider: null,
        agent: 'qa',
        inputSchema: z.object({
          ref: z.string().max(200).nullable().optional(),
          requirement: z.string().max(20_000).nullable().optional(),
          codeGenerationId: z.string().uuid().nullable().optional(),
          acceptanceCriteria: z.array(z.string()).nullable().optional(),
        }),
        permission: 'qa:run',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 1_800_000,
        defaultRetry: { maxAttempts: 2 },
        execute: (input, ctx) => self.run(input, ctx),
        async simulate(input, ctx) {
          const run = await self.prisma.qATestRun.create({
            data: {
              organizationId: ctx.organizationId,
              projectId: ctx.project!.id,
              executionId: ctx.executionId ?? null,
              type: 'REGRESSION',
              status: 'PASSED',
              title: `QA · ${input.ref ?? 'main'}`,
              ref: input.ref ?? 'main',
              total: 31,
              passed: 31,
              failed: 0,
              skipped: 0,
              durationMs: 41_000,
              simulated: true,
              testCases: [
                {
                  id: 'TC-1',
                  title: 'Request reset for existing user',
                  type: 'API',
                  priority: 'P0',
                  steps: [],
                  expected: '202 Accepted',
                  preconditions: null,
                },
              ],
              startedAt: new Date(),
              completedAt: new Date(),
            },
          });
          return {
            simulated: true,
            output: {
              qaRunId: run.id,
              status: 'PASSED',
              total: 31,
              passed: 31,
              failed: 0,
              skipped: 0,
              testCases: 12,
              summary: '[Simulated] QA passed: 31/31 tests',
              analysis: null,
            },
            summary: '[Simulated] QA passed: 31/31 tests · 12 cases derived',
          };
        },
      }),
    );
  }
}

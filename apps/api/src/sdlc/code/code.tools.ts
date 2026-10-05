import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@forgeline/database';
import { codeChangeSetSchema, failureAnalysisSchema, reviewResultSchema, type ImplementationPlan, type ReviewResult } from '@forgeline/ai';
import { defineLooseTool, idempotencyMarker, type AnySdlcTool, type ToolExecutionContext } from '@forgeline/integrations';
import { ToolError } from '@forgeline/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EventBus } from '../../events/event-bus.service';
import { ToolRegistry } from '../../tools/tool-registry.service';
import { KnowledgeService } from '../../knowledge/knowledge.service';
import { AgentTaskRunner, forPrompt } from '../agent-task-runner.service';
import { SandboxService, type CommandResult } from '../sandbox/sandbox.service';
import { buildDiff, commentableLines, diffStats, failureExcerpt, parseTestSummary, sanitizeChangeSet, type StoredFile } from './code-utils';

interface ValidationCheck {
  name: string;
  command: string;
  status: 'passed' | 'failed' | 'skipped';
  exitCode: number | null;
  durationMs: number;
  excerpt: string | null;
}

export type ValidationResult = {
  passed: boolean | null;
  ran: boolean;
  checks: ValidationCheck[];
  failures: { check: string; output: string }[];
  tests: ReturnType<typeof parseTestSummary> | null;
  summary: string;
};

const SEVERITY_ORDER = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'] as const;

export function reviewToMarkdown(r: ReviewResult, title: string): string {
  const icon: Record<string, string> = { passed: '✅', warning: '⚠️', failed: '❌' };
  const counts = SEVERITY_ORDER.map((s) => `${s.charAt(0) + s.slice(1).toLowerCase()} ${r.findings.filter((f) => f.severity === s).length}`).join(' · ');
  const bySeverity = SEVERITY_ORDER.map((sev) => {
    const items = r.findings.filter((f) => f.severity === sev);
    if (!items.length) return '';
    return `### ${sev.charAt(0) + sev.slice(1).toLowerCase()}\n${items.map((f) => `- **${f.title}** (${f.category.toLowerCase()})${f.file ? ` — \`${f.file}${f.line ? `:${f.line}` : ''}\`` : ''}\n  ${f.detail}${f.suggestion ? `\n  _Suggestion:_ ${f.suggestion}` : ''}`).join('\n')}`;
  })
    .filter(Boolean)
    .join('\n\n');
  return [
    `# AI Code Review — ${title}`,
    `**Verdict:** ${r.verdict.replace('_', ' ')} · **Risk:** ${r.riskLevel}`,
    r.summary,
    `**Findings:** ${counts}`,
    `| Dimension | Result |\n|---|---|\n${Object.entries(r.dimensions).map(([k, v]) => `| ${k} | ${icon[v] ?? ''} ${v} |`).join('\n')}`,
    bySeverity,
    r.testCoverageGaps.length ? `### Test coverage gaps\n${r.testCoverageGaps.map((g) => `- ${g}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Code agent: generation grounded in the existing repository, sandbox
 * validation (install → lint → typecheck → tests), self-repair, commit, and
 * AI code review published to the pull request.
 */
@Injectable()
export class CodeTools implements OnModuleInit {
  private readonly logger = new Logger(CodeTools.name);

  constructor(
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
    private readonly runner: AgentTaskRunner,
    private readonly sandbox: SandboxService,
    private readonly knowledge: KnowledgeService,
    private readonly events: EventBus,
  ) {}

  private requireRepo(ctx: ToolExecutionContext) {
    const repo = ctx.project?.repository;
    if (!repo) throw new ToolError('not_configured', 'No repository is linked to this project', { retryable: false });
    return repo;
  }

  private async loadGeneration(ctx: ToolExecutionContext, id: string) {
    const cg = await this.prisma.codeGeneration.findFirst({ where: { id, organizationId: ctx.organizationId } });
    if (!cg) throw new ToolError('not_found', `Code generation ${id} not found`, { retryable: false });
    return { cg, files: cg.files as unknown as StoredFile[] };
  }

  private tool(name: string): AnySdlcTool {
    return this.registry.get(name)!;
  }

  // ───────────────────────── generate ─────────────────────────

  async generate(input: { requirement: string; ticketKey?: string | null; planArtifactId?: string | null; branch: string; baseBranch?: string | null }, ctx: ToolExecutionContext) {
    const repo = this.requireRepo(ctx);
    const gh = await ctx.clients.github();
    const baseBranch = input.baseBranch ?? repo.defaultBranch;
    const baseSha = await gh.getBranchSha(repo.owner, repo.name, baseBranch);
    if (!baseSha) throw new ToolError('not_found', `Base branch ${baseBranch} not found`, { retryable: false });

    // Idempotency: a retry of this step reuses the generation it already produced.
    const marker = idempotencyMarker(ctx);
    const existing = await this.prisma.codeGeneration.findFirst({ where: { organizationId: ctx.organizationId, executionId: ctx.executionId ?? undefined, branch: input.branch, status: { in: ['READY', 'VALIDATING', 'COMMITTED'] } } });
    if (existing && ctx.executionId) {
      const files = existing.files as unknown as StoredFile[];
      return { output: { codeGenerationId: existing.id, files: files.map((f) => ({ path: f.path, action: f.action })), summary: 'Reused generated change set', reused: true }, summary: `Reused change set (${files.length} files)` };
    }

    const plan = input.planArtifactId
      ? ((await this.prisma.artifact.findFirst({ where: { id: input.planArtifactId, organizationId: ctx.organizationId } }))?.data as unknown as ImplementationPlan | null)
      : null;
    const cg = await this.prisma.codeGeneration.create({
      data: {
        organizationId: ctx.organizationId,
        projectId: ctx.project!.id,
        repositoryId: repo.id,
        executionId: ctx.executionId ?? null,
        requirement: input.requirement,
        status: 'GENERATING',
        plan: (plan ?? undefined) as Prisma.InputJsonValue | undefined,
        baseBranch,
        baseSha,
        branch: input.branch,
        createdById: ctx.userId,
      },
    });

    try {
      // Gather the files the plan touches plus neighbours for conventions.
      const { tree } = await gh.getTree(repo.owner, repo.name, baseSha);
      const paths = new Set(tree.filter((t) => t.type === 'blob').map((t) => t.path));
      const targets = (plan?.affectedFiles ?? []).map((f) => f.path);
      const wanted = new Set<string>(targets.filter((p) => paths.has(p)));
      for (const t of targets) {
        const dir = t.includes('/') ? t.slice(0, t.lastIndexOf('/') + 1) : '';
        const neighbours = [...paths].filter((p) => p.startsWith(dir) && !p.slice(dir.length).includes('/') && /\.(ts|tsx|js|py|go|java|rb)$/.test(p)).slice(0, 3);
        neighbours.forEach((n) => wanted.add(n));
      }
      const testExample = [...paths].find((p) => /\.(spec|test)\.(ts|js)$/.test(p) && !p.includes('node_modules'));
      if (testExample) wanted.add(testExample);
      for (const manifest of ['package.json', 'tsconfig.json', 'pyproject.toml', 'go.mod']) if (paths.has(manifest)) wanted.add(manifest);
      const contents = new Map<string, string>();
      for (const p of [...wanted].slice(0, 24)) {
        const f = await gh.getFileContent(repo.owner, repo.name, p, baseSha);
        if (f) contents.set(p, f.content.slice(0, 40_000));
      }
      const knowledge = await this.knowledge.retrieve({ organizationId: ctx.organizationId, projectId: ctx.project?.id, query: input.requirement, k: 6, maxChars: 8000 });
      const filesBlock = [...contents.entries()].map(([p, c]) => `=== ${p} ===\n${c}`).join('\n\n');

      const { output } = await this.runner.structured({
        ctx,
        agent: 'code',
        task: 'Generate code changes',
        prompt: 'codeGenerate',
        variables: {
          plan: forPrompt(plan ?? { note: 'No plan provided; infer minimal changes' }, 16_000),
          files: forPrompt(filesBlock || '(no existing files loaded)', 120_000),
          context: forPrompt(`${knowledge.context}\n\nRepository files:\n${[...paths].slice(0, 300).join('\n')}`, 20_000),
          requirement: input.ticketKey ? `${input.requirement} (ticket ${input.ticketKey})` : input.requirement,
        },
        schema: codeChangeSetSchema,
        schemaName: 'code_change_set',
        role: 'coder',
        summarize: (c) => `${c.files.length} file(s), ${c.testsAdded.length} test file(s): ${c.summary}`,
      });
      const sanitized = sanitizeChangeSet(output.files);
      const stored: StoredFile[] = [];
      for (const f of sanitized) {
        const original = contents.get(f.path) ?? (paths.has(f.path) ? ((await gh.getFileContent(repo.owner, repo.name, f.path, baseSha))?.content ?? null) : null);
        stored.push({ ...f, action: original === null && f.action !== 'delete' ? 'create' : f.action, original });
      }
      const diff = buildDiff(stored);
      const stats = diffStats(stored);
      await this.prisma.codeGeneration.update({
        where: { id: cg.id },
        data: { status: 'READY', files: stored as unknown as Prisma.InputJsonValue, diff, validation: { summary: 'Not validated yet', commitMessage: `${output.commitMessage}\n\nRefs: ${marker}` } as Prisma.InputJsonValue },
      });
      await this.events.publish({ type: 'code.generated', organizationId: ctx.organizationId, projectId: ctx.project?.id, executionId: ctx.executionId, data: { codeGenerationId: cg.id, files: stored.length, ...stats } });
      return {
        output: { codeGenerationId: cg.id, files: stored.map((f) => ({ path: f.path, action: f.action })), summary: output.summary, commitMessage: output.commitMessage, testsAdded: output.testsAdded, additions: stats.additions, deletions: stats.deletions },
        summary: `Generated ${stored.length} file change(s) (+${stats.additions} −${stats.deletions}), ${output.testsAdded.length} test file(s)`,
        artifacts: [{ type: 'CODE_DIFF' as const, title: `Diff · ${input.branch}`, content: diff, contentType: 'text/x-diff', data: { files: stored.map((f) => ({ path: f.path, action: f.action })), ...stats } }],
      };
    } catch (err) {
      await this.prisma.codeGeneration.update({ where: { id: cg.id }, data: { status: 'FAILED', validation: { error: (err as Error).message } } });
      throw err;
    }
  }

  // ───────────────────────── validate ─────────────────────────

  async validate(codeGenerationId: string, ctx: ToolExecutionContext): Promise<ValidationResult> {
    const { cg, files } = await this.loadGeneration(ctx, codeGenerationId);
    const repo = this.requireRepo(ctx);
    if (!this.sandbox.enabled) {
      const result: ValidationResult = { passed: null, ran: false, checks: [], failures: [], tests: null, summary: 'Validation not executed: sandbox disabled (SANDBOX_DRIVER). Tests will run in CI.' };
      await this.prisma.codeGeneration.update({ where: { id: cg.id }, data: { validation: { ...(cg.validation as object), ...result } as unknown as Prisma.InputJsonValue } });
      ctx.logger.warn(result.summary);
      return result;
    }
    await this.prisma.codeGeneration.update({ where: { id: cg.id }, data: { status: 'VALIDATING' } });
    const gh = await ctx.clients.github();
    const ws = await this.sandbox.createWorkspace(gh, repo.owner, repo.name, cg.baseSha ?? repo.defaultBranch, ctx.signal);
    try {
      await this.sandbox.applyChanges(ws, files.map((f) => ({ path: f.path, content: f.content })));
      const s = repo.settings;
      const steps: [string, string | undefined][] = [
        ['install', s.installCommand],
        ['lint', s.lintCommand],
        ['typecheck', s.typecheckCommand],
        ['test', s.testCommand],
      ];
      const checks: ValidationCheck[] = [];
      const failures: { check: string; output: string }[] = [];
      let tests: ReturnType<typeof parseTestSummary> | null = null;
      let blocked = false;
      for (const [name, command] of steps) {
        if (!command) {
          checks.push({ name, command: '', status: 'skipped', exitCode: null, durationMs: 0, excerpt: 'Not configured' });
          continue;
        }
        if (blocked) {
          checks.push({ name, command, status: 'skipped', exitCode: null, durationMs: 0, excerpt: 'Skipped because install failed' });
          continue;
        }
        if (name === 'typecheck' && /\btsc\b/.test(command) && (await this.sandbox.readFile(ws, 'tsconfig.json')) === null) {
          checks.push({ name, command, status: 'skipped', exitCode: null, durationMs: 0, excerpt: 'No tsconfig.json in repository' });
          continue;
        }
        ctx.progress({ message: `Running ${name}…` });
        const res: CommandResult = await this.sandbox.run(ws, command, { image: s.sandboxImage, signal: ctx.signal });
        const ok = res.exitCode === 0 && !res.timedOut;
        if (name === 'test') tests = parseTestSummary(res.output);
        checks.push({ name, command, status: ok ? 'passed' : 'failed', exitCode: res.exitCode, durationMs: res.durationMs, excerpt: ok ? null : failureExcerpt(res.output, 3000) });
        ctx.logger[ok ? 'info' : 'warn'](`${name}: ${ok ? 'passed' : `failed (exit ${res.exitCode}${res.timedOut ? ', timed out' : ''})`} in ${Math.round(res.durationMs / 1000)}s`);
        if (!ok) {
          failures.push({ check: name, output: failureExcerpt(res.output) });
          if (name === 'install') blocked = true;
        }
      }
      const ran = checks.some((c) => c.status !== 'skipped');
      const passed = ran ? failures.length === 0 : null;
      const summary = !ran
        ? 'No validation commands configured for this repository'
        : passed
          ? `All checks passed (${checks.filter((c) => c.status === 'passed').map((c) => c.name).join(', ')})${tests?.parsed ? ` · ${tests.passed}/${tests.total} tests` : ''}`
          : `Failed: ${failures.map((f) => f.check).join(', ')}${tests?.parsed ? ` · ${tests.failed} failing test(s)` : ''}`;
      const result: ValidationResult = { passed, ran, checks, failures, tests, summary };
      await this.prisma.codeGeneration.update({ where: { id: cg.id }, data: { status: passed === false ? 'READY' : 'READY', validation: { ...(cg.validation as object), ...result } as unknown as Prisma.InputJsonValue } });
      if (tests?.parsed || checks.find((c) => c.name === 'test')?.status !== 'skipped') {
        await this.prisma.qATestRun.create({
          data: {
            organizationId: ctx.organizationId,
            projectId: ctx.project!.id,
            repositoryId: repo.id,
            executionId: ctx.executionId ?? null,
            type: 'UNIT',
            status: checks.find((c) => c.name === 'test')?.status === 'passed' ? 'PASSED' : checks.find((c) => c.name === 'test')?.status === 'skipped' ? 'SKIPPED' : 'FAILED',
            title: `Validation · ${cg.branch}`,
            ref: cg.branch,
            total: tests?.total ?? 0,
            passed: tests?.passed ?? 0,
            failed: tests?.failed ?? 0,
            skipped: tests?.skipped ?? 0,
            output: failures.find((f) => f.check === 'test')?.output ?? null,
            command: repo.settings.testCommand ?? null,
            durationMs: checks.reduce((acc, c) => acc + c.durationMs, 0),
            startedAt: new Date(),
            completedAt: new Date(),
          },
        });
      }
      return result;
    } finally {
      await ws.dispose();
    }
  }

  // ───────────────────────── fix ─────────────────────────

  async fix(input: { codeGenerationId: string; failures: unknown; source?: string; commit?: boolean; branch?: string | null }, ctx: ToolExecutionContext) {
    const { cg, files } = await this.loadGeneration(ctx, input.codeGenerationId);
    const failureText = this.describeFailures(input.failures, input.source);
    const { output: analysis } = await this.runner.structured({
      ctx,
      agent: 'qa',
      task: 'Analyse failure root cause',
      prompt: 'qaAnalyzeFailure',
      variables: { change: forPrompt({ requirement: cg.requirement, files: files.map((f) => `${f.action} ${f.path}`) }, 4000), output: forPrompt(failureText, 20_000) },
      schema: failureAnalysisSchema,
      schemaName: 'failure_analysis',
      role: 'reviewer',
      summarize: (a) => `${a.category} (${Math.round(a.confidence * 100)}%): ${a.rootCause}`,
    });
    if (!analysis.shouldAttemptFix && ['environment', 'flaky', 'configuration'].includes(analysis.category)) {
      throw new ToolError('external', `Not a code defect (${analysis.category}): ${analysis.rootCause}. No code change attempted.`, { retryable: false, details: { analysis } });
    }
    const current = files.filter((f) => f.content !== null).map((f) => `=== ${f.path} ===\n${f.content}`).join('\n\n');
    const { output } = await this.runner.structured({
      ctx,
      agent: 'code',
      task: `Fix ${input.source ?? 'validation'} failures`,
      prompt: 'codeFix',
      variables: { requirement: cg.requirement, files: forPrompt(current, 120_000), failures: forPrompt(failureText, 24_000), analysis: forPrompt(analysis, 4000) },
      schema: codeChangeSetSchema,
      schemaName: 'code_fix',
      role: 'coder',
      summarize: (c) => `${c.files.length} file(s) changed: ${c.summary}`,
    });
    const changes = sanitizeChangeSet(output.files);
    const byPath = new Map(files.map((f) => [f.path, f]));
    const repo = this.requireRepo(ctx);
    const gh = await ctx.clients.github();
    for (const c of changes) {
      const prev = byPath.get(c.path);
      const original = prev ? prev.original : ((await gh.getFileContent(repo.owner, repo.name, c.path, cg.baseSha ?? repo.defaultBranch))?.content ?? null);
      byPath.set(c.path, { ...c, original, action: original === null && c.action !== 'delete' ? 'create' : c.action });
    }
    const merged = [...byPath.values()];
    const diff = buildDiff(merged);
    let commitSha: string | null = null;
    if (input.commit) {
      const branch = input.branch ?? cg.branch;
      if (!branch) throw new ToolError('validation', 'Branch required to commit the fix', { retryable: false });
      const res = await this.tool('github.commitFiles').execute({ branch, message: output.commitMessage || `fix: address ${input.source ?? 'validation'} failures`, files: changes.map((c) => ({ path: c.path, content: c.content })) }, ctx);
      commitSha = (res.output as { sha: string }).sha;
    }
    await this.prisma.codeGeneration.update({
      where: { id: cg.id },
      data: { files: merged as unknown as Prisma.InputJsonValue, diff, iterations: { increment: 1 }, ...(commitSha && { commitSha }) },
    });
    return {
      output: { codeGenerationId: cg.id, filesChanged: changes.map((c) => c.path), commitSha, rootCause: analysis.rootCause, category: analysis.category },
      summary: `Fixed ${changes.length} file(s) — root cause: ${analysis.rootCause.slice(0, 160)}${commitSha ? ` (committed ${commitSha.slice(0, 7)})` : ''}`,
      artifacts: [{ type: 'CODE_DIFF' as const, title: `Fix · ${input.source ?? 'validation'} (iteration ${cg.iterations + 1})`, content: diff, contentType: 'text/x-diff' }],
    };
  }

  private describeFailures(raw: unknown, source?: string): string {
    if (!raw || typeof raw !== 'object') return String(raw ?? 'Unknown failure');
    const r = raw as Partial<ValidationResult> & { failedJobs?: { name: string; logExcerpt: string }[]; findings?: ReviewResult['findings']; summary?: string };
    if (r.failures?.length) return r.failures.map((f) => `## ${f.check} failed\n${f.output}`).join('\n\n');
    if (r.failedJobs?.length) return `CI failures:\n${r.failedJobs.map((j) => `## ${j.name}\n${j.logExcerpt}`).join('\n\n')}`;
    if (r.findings?.length) {
      return `Code review findings to address (${source ?? 'review'}):\n${r.findings
        .filter((f) => ['CRITICAL', 'HIGH'].includes(f.severity))
        .map((f) => `- [${f.severity}] ${f.title} ${f.file ? `(${f.file}:${f.line ?? '?'})` : ''}: ${f.detail}${f.suggestion ? ` Suggestion: ${f.suggestion}` : ''}`)
        .join('\n')}`;
    }
    return JSON.stringify(raw).slice(0, 20_000);
  }

  // ───────────────────────── commit ─────────────────────────

  async commit(input: { codeGenerationId: string; branch: string; message?: string }, ctx: ToolExecutionContext) {
    const { cg, files } = await this.loadGeneration(ctx, input.codeGenerationId);
    const message = input.message ?? (cg.validation as { commitMessage?: string } | null)?.commitMessage ?? `feat: ${cg.requirement.slice(0, 60)}`;
    const res = await this.tool('github.commitFiles').execute({ branch: input.branch, message, files: files.map((f) => ({ path: f.path, content: f.content })) }, ctx);
    const out = res.output as { sha: string; url: string };
    await this.prisma.codeGeneration.update({ where: { id: cg.id }, data: { status: 'COMMITTED', commitSha: out.sha, branch: input.branch } });
    return { ...res, output: { ...out, branch: input.branch, files: files.length } };
  }

  // ───────────────────────── review ─────────────────────────

  async review(input: { codeGenerationId?: string | null; pullNumber?: number | null }, ctx: ToolExecutionContext) {
    let diff: string;
    let title: string;
    let description = '';
    let prUrl: string | null = null;
    let headSha: string | null = null;
    let repositoryId: string | null = ctx.project?.repository?.id ?? null;
    if (input.codeGenerationId) {
      const { cg } = await this.loadGeneration(ctx, input.codeGenerationId);
      diff = cg.diff ?? '';
      title = cg.branch ?? 'Generated change';
      description = cg.requirement;
      repositoryId = cg.repositoryId;
      prUrl = cg.prUrl;
    } else if (input.pullNumber) {
      const pr = await this.tool('github.getPullRequest').execute({ number: input.pullNumber, includeDiff: true }, ctx);
      const o = pr.output as { title: string; body: string; diff: string; url: string; headSha: string };
      diff = o.diff;
      title = `#${input.pullNumber} ${o.title}`;
      description = o.body;
      prUrl = o.url;
      headSha = o.headSha;
    } else {
      throw new ToolError('validation', 'Provide codeGenerationId or pullNumber', { retryable: false });
    }
    if (!diff.trim()) throw new ToolError('validation', 'Nothing to review: the diff is empty', { retryable: false });
    const knowledge = await this.knowledge.retrieve({ organizationId: ctx.organizationId, projectId: ctx.project?.id, query: `engineering guidelines security conventions ${title}`, k: 4, maxChars: 5000, documentTypes: undefined });
    const { output: r } = await this.runner.structured({
      ctx,
      agent: 'review',
      task: `Review ${title}`,
      prompt: 'codeReview',
      variables: { title, description: forPrompt(description, 4000), context: forPrompt(knowledge.context, 5000), diff: forPrompt(diff, 150_000) },
      schema: reviewResultSchema,
      schemaName: 'code_review',
      role: 'reviewer',
      summarize: (x) => `${x.verdict}: ${x.findings.length} finding(s), risk ${x.riskLevel}`,
    });
    const count = (sev: string) => r.findings.filter((f) => f.severity === sev).length;
    const review = await this.prisma.codeReview.create({
      data: {
        organizationId: ctx.organizationId,
        projectId: ctx.project!.id,
        repositoryId,
        executionId: ctx.executionId ?? null,
        prNumber: input.pullNumber ?? null,
        prUrl,
        headSha,
        title,
        status: 'COMPLETED',
        verdict: r.verdict,
        riskLevel: r.riskLevel,
        summary: r.summary,
        criticalCount: count('CRITICAL'),
        highCount: count('HIGH'),
        mediumCount: count('MEDIUM'),
        lowCount: count('LOW') + count('INFO'),
        findings: r.findings as unknown as Prisma.InputJsonValue,
        dimensions: r.dimensions as Prisma.InputJsonValue,
      },
    });
    await this.events.publish({ type: 'code.reviewed', organizationId: ctx.organizationId, projectId: ctx.project?.id, executionId: ctx.executionId, data: { codeReviewId: review.id, verdict: r.verdict, critical: count('CRITICAL'), high: count('HIGH') } });
    return {
      output: { codeReviewId: review.id, verdict: r.verdict, riskLevel: r.riskLevel, critical: count('CRITICAL'), high: count('HIGH'), medium: count('MEDIUM'), low: count('LOW'), dimensions: r.dimensions, summary: r.summary, findings: r.findings.slice(0, 30), testCoverageGaps: r.testCoverageGaps },
      summary: `${r.verdict.replace('_', ' ')} — ${count('CRITICAL')} critical, ${count('HIGH')} high, ${count('MEDIUM')} medium, ${count('LOW')} low`,
      artifacts: [{ type: 'REVIEW_REPORT' as const, title: `Review · ${title}`, content: reviewToMarkdown(r, title), data: { codeReviewId: review.id } }],
    };
  }

  async publishReview(input: { codeReviewId: string; pullNumber: number }, ctx: ToolExecutionContext) {
    const review = await this.prisma.codeReview.findFirst({ where: { id: input.codeReviewId, organizationId: ctx.organizationId } });
    if (!review) throw new ToolError('not_found', 'Review not found', { retryable: false });
    const repo = this.requireRepo(ctx);
    const gh = await ctx.clients.github();
    const marker = `<!-- forgeline-review:${review.id} -->`;
    const existing = await gh.listReviews(repo.owner, repo.name, input.pullNumber);
    const already = existing.find((r) => r.body?.includes(marker));
    if (already) return { output: { posted: true, reviewId: already.id, reused: true }, summary: `Review already posted on #${input.pullNumber}` };
    const diff = await gh.getPullRequestDiff(repo.owner, repo.name, input.pullNumber);
    const valid = commentableLines(diff);
    const findings = (review.findings as unknown as ReviewResult['findings']).filter((f) => ['CRITICAL', 'HIGH', 'MEDIUM'].includes(f.severity));
    const comments = findings
      .filter((f) => f.file && f.line && valid.get(f.file)?.has(f.line))
      .slice(0, 30)
      .map((f) => ({ path: f.file!, line: f.line!, body: `**${f.severity} · ${f.category.toLowerCase()}** — ${f.title}\n\n${f.detail}${f.suggestion ? `\n\n💡 ${f.suggestion}` : ''}` }));
    const r = { ...review, findings: review.findings } as unknown as ReviewResult & { title: string };
    const body = `${reviewToMarkdown({ summary: review.summary ?? '', verdict: review.verdict ?? 'COMMENT', riskLevel: review.riskLevel ?? 'LOW', findings: review.findings as unknown as ReviewResult['findings'], dimensions: review.dimensions as unknown as ReviewResult['dimensions'], testCoverageGaps: [] }, r.title)}\n\n${marker}`;
    // COMMENT avoids GitHub's restriction on approving/requesting changes on your own PR; the verdict is in the body.
    const posted = await gh.createReview(repo.owner, repo.name, input.pullNumber, { body, event: 'COMMENT', comments });
    await this.prisma.codeReview.update({ where: { id: review.id }, data: { postedToProvider: true, externalReviewId: String(posted.id), prNumber: input.pullNumber, prUrl: posted.html_url } });
    return { output: { posted: true, reviewId: posted.id, inlineComments: comments.length, url: posted.html_url }, summary: `Posted review to PR #${input.pullNumber} with ${comments.length} inline comment(s)` };
  }

  // ───────────────────────── registration ─────────────────────────

  onModuleInit(): void {
    const self = this;
    const prisma = this.prisma;
    const demoFiles = [
      { path: 'src/auth/password-reset.service.ts', action: 'create' as const },
      { path: 'src/auth/auth.controller.ts', action: 'modify' as const },
      { path: 'src/auth/password-reset.service.spec.ts', action: 'create' as const },
    ];

    this.registry.register(
      defineLooseTool({
        name: 'code.generate',
        title: 'Generate code',
        description: 'Generate a change set (code + tests) for the plan, grounded in the existing repository and conventions.',
        category: 'ai',
        provider: 'GITHUB',
        agent: 'code',
        inputSchema: z.object({ requirement: z.string().min(3).max(20_000), ticketKey: z.string().nullable().optional(), planArtifactId: z.string().uuid().nullable().optional(), branch: z.string().min(1).max(200), baseBranch: z.string().max(200).nullable().optional() }),
        permission: 'code:write',
        risk: 'write',
        sideEffects: false,
        approvalAction: 'code.generate',
        defaultTimeoutMs: 1_200_000,
        defaultRetry: { maxAttempts: 2 },
        execute: (input, ctx) => self.generate(input, ctx),
        async simulate(input, ctx) {
          const cg = await prisma.codeGeneration.create({
            data: { organizationId: ctx.organizationId, projectId: ctx.project!.id, executionId: ctx.executionId ?? null, requirement: input.requirement, status: 'READY', branch: input.branch, baseBranch: input.baseBranch ?? 'main', simulated: true, files: demoFiles.map((f) => ({ ...f, content: '// simulated', original: null, explanation: 'demo' })), diff: '--- /dev/null\n+++ b/src/auth/password-reset.service.ts\n@@ -0,0 +1,3 @@\n+// Simulated change (demo mode)\n+export class PasswordResetService {}\n+', createdById: ctx.userId },
          });
          return { simulated: true, output: { codeGenerationId: cg.id, files: demoFiles, summary: 'Simulated change set', commitMessage: 'feat(auth): add password reset', testsAdded: ['src/auth/password-reset.service.spec.ts'], additions: 142, deletions: 6 }, summary: '[Simulated] Generated 3 file change(s) (+142 −6), 1 test file' };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'code.validate',
        title: 'Validate code',
        description: 'Run install, lint, typecheck and tests for the change set in an isolated sandbox.',
        category: 'quality',
        provider: null,
        agent: 'qa',
        inputSchema: z.object({ codeGenerationId: z.string().uuid() }),
        permission: 'qa:run',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 1_800_000,
        defaultRetry: { maxAttempts: 2 },
        async execute(input, ctx) {
          const r = await self.validate(input.codeGenerationId, ctx);
          return { output: r, summary: r.summary, artifacts: r.ran ? [{ type: 'TEST_REPORT' as const, title: 'Validation report', content: `# Validation\n\n${r.summary}\n\n| Check | Status | Duration |\n|---|---|---|\n${r.checks.map((c) => `| ${c.name} | ${c.status} | ${Math.round(c.durationMs / 1000)}s |`).join('\n')}\n\n${r.failures.map((f) => `## ${f.check}\n\`\`\`\n${f.output}\n\`\`\``).join('\n\n')}` }] : [] };
        },
        async simulate(_input, ctx) {
          const polls = ((ctx.checkpoint as { polls?: number } | undefined)?.polls ?? 0) + 1;
          const iteration = Number(String(ctx.idempotencyKey).split(':').pop() ?? 0);
          const result: ValidationResult = polls === 1 && iteration === 0
            ? { passed: false, ran: true, checks: [{ name: 'lint', command: 'npm run lint', status: 'passed', exitCode: 0, durationMs: 4100, excerpt: null }, { name: 'test', command: 'npm test', status: 'failed', exitCode: 1, durationMs: 9200, excerpt: 'FAIL src/auth/password-reset.service.spec.ts' }], failures: [{ check: 'test', output: 'FAIL src/auth/password-reset.service.spec.ts\n  ✕ rejects expired tokens (expected 410, received 200)' }], tests: { total: 24, passed: 23, failed: 1, skipped: 0, parsed: true }, summary: '[Simulated] Failed: test · 1 failing test(s)' }
            : { passed: true, ran: true, checks: [{ name: 'lint', command: 'npm run lint', status: 'passed', exitCode: 0, durationMs: 3900, excerpt: null }, { name: 'test', command: 'npm test', status: 'passed', exitCode: 0, durationMs: 8800, excerpt: null }], failures: [], tests: { total: 24, passed: 24, failed: 0, skipped: 0, parsed: true }, summary: '[Simulated] All checks passed (lint, test) · 24/24 tests' };
          return { simulated: true, output: result, summary: result.summary };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'code.fix',
        title: 'Fix failures',
        description: 'Analyse failing validation/CI/review output, find the root cause and repair the change set (optionally committing).',
        category: 'ai',
        provider: null,
        agent: 'code',
        inputSchema: z.object({ codeGenerationId: z.string().uuid(), failures: z.unknown(), source: z.enum(['validation', 'review', 'ci']).optional(), commit: z.boolean().default(false), branch: z.string().nullable().optional() }),
        permission: 'code:write',
        risk: 'write',
        sideEffects: false,
        defaultTimeoutMs: 1_200_000,
        defaultRetry: { maxAttempts: 2 },
        execute: (input, ctx) => self.fix(input, ctx),
        async simulate(input) {
          return { simulated: true, output: { codeGenerationId: input.codeGenerationId, filesChanged: ['src/auth/password-reset.service.ts'], commitSha: input.commit ? 'demo-fix' : null, rootCause: 'Expired tokens were not rejected (missing expiry check).', category: 'code_bug' }, summary: '[Simulated] Fixed 1 file — root cause: missing token expiry check' };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'code.commit',
        title: 'Commit change set',
        description: 'Commit the validated change set to the feature branch.',
        category: 'github',
        provider: 'GITHUB',
        agent: 'code',
        inputSchema: z.object({ codeGenerationId: z.string().uuid(), branch: z.string().min(1).max(200), message: z.string().max(5000).optional() }),
        permission: 'code:write',
        risk: 'write',
        sideEffects: true,
        approvalAction: 'code.commit',
        execute: (input, ctx) => self.commit(input, ctx),
        async simulate(input) {
          return { simulated: true, output: { sha: 'demo1234abcd', url: null, branch: input.branch, files: 3 }, summary: `[Simulated] Committed 3 file(s) to ${input.branch}` };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'code.review',
        title: 'AI code review',
        description: 'Review a change set or pull request for correctness, security, performance, architecture, tests and more.',
        category: 'quality',
        provider: null,
        agent: 'review',
        inputSchema: z.object({ codeGenerationId: z.string().uuid().nullable().optional(), pullNumber: z.coerce.number().int().positive().nullable().optional() }),
        permission: 'agent:use',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 600_000,
        execute: (input, ctx) => self.review(input, ctx),
        async simulate(input, ctx) {
          const review = await prisma.codeReview.create({
            data: { organizationId: ctx.organizationId, projectId: ctx.project!.id, executionId: ctx.executionId ?? null, prNumber: input.pullNumber ?? null, title: input.pullNumber ? `#${input.pullNumber}` : 'Generated change', status: 'COMPLETED', verdict: 'COMMENT', riskLevel: 'LOW', summary: 'Simulated review (demo mode).', criticalCount: 0, highCount: 0, mediumCount: 2, lowCount: 3, simulated: true, findings: [{ severity: 'MEDIUM', category: 'SECURITY', file: 'src/auth/password-reset.service.ts', line: 42, title: 'Rate-limit reset requests', detail: 'Add per-IP and per-account throttling.', suggestion: 'Use the existing ThrottlerGuard.' }], dimensions: { security: 'warning', performance: 'passed', architecture: 'passed', tests: 'passed', maintainability: 'passed' } },
          });
          return { simulated: true, output: { codeReviewId: review.id, verdict: 'COMMENT', riskLevel: 'LOW', critical: 0, high: 0, medium: 2, low: 3, dimensions: review.dimensions, summary: review.summary, findings: review.findings, testCoverageGaps: [] }, summary: '[Simulated] COMMENT — 0 critical, 0 high, 2 medium, 3 low' };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'code.publishReview',
        title: 'Post review to PR',
        description: 'Publish the AI review to the GitHub pull request with inline comments.',
        category: 'github',
        provider: 'GITHUB',
        agent: 'review',
        inputSchema: z.object({ codeReviewId: z.string().uuid(), pullNumber: z.coerce.number().int().positive() }),
        permission: 'code:write',
        risk: 'write',
        sideEffects: true,
        execute: (input, ctx) => self.publishReview(input, ctx),
        async simulate(input) {
          return { simulated: true, output: { posted: true, reviewId: 0, inlineComments: 1, url: null }, summary: `[Simulated] Posted review to PR #${input.pullNumber}` };
        },
      }),
    );
  }
}

import { Injectable } from '@nestjs/common';
import type { WorkflowExecution, WorkflowExecutionStep } from '@forgeline/database';
import { PrismaService } from '../common/prisma/prisma.service';
import { RiskAssessor, type ApprovalEvidence } from '../approvals/risk-assessor.service';

type Output = Record<string, unknown>;

const lastOutput = (steps: WorkflowExecutionStep[], tools: string[]): Output | null => {
  const matches = steps.filter((s) => s.tool && tools.includes(s.tool) && s.status === 'COMPLETED' && s.output);
  const latest = matches.sort((a, b) => (b.completedAt?.getTime() ?? 0) - (a.completedAt?.getTime() ?? 0))[0];
  return (latest?.output as Output | undefined) ?? null;
};

/**
 * Gathers the evidence an approver needs (changes, CI, QA, review, risk) from
 * the run's completed steps, so approval decisions are contextual.
 */
@Injectable()
export class ApprovalContextBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly risk: RiskAssessor,
  ) {}

  async build(
    execution: WorkflowExecution,
    steps: WorkflowExecutionStep[],
    params: { action: string; environment?: string | null; version?: string | null; userId: string | null },
  ) {
    const codegen = lastOutput(steps, ['code.generate', 'code.fix']);
    const pr = lastOutput(steps, ['github.createPullRequest', 'github.getPullRequest']);
    const ci = lastOutput(steps, ['github_actions.awaitRuns', 'devops.runPipeline']);
    const qa = lastOutput(steps, ['qa.run']);
    const review = lastOutput(steps, ['code.review']);
    const ticket = lastOutput(steps, ['ticket.create', 'ticket.get', 'jira.createIssue', 'jira.getIssue']);

    let files: { path: string; action?: string; status?: string }[] = [];
    if (codegen?.codeGenerationId) {
      const cg = await this.prisma.codeGeneration.findUnique({ where: { id: String(codegen.codeGenerationId) }, select: { files: true } });
      files = (cg?.files as { path: string; action: string }[] | null) ?? [];
    } else if (Array.isArray(pr?.files)) {
      files = pr.files as { path: string; status: string }[];
    }

    const ciStatus: ApprovalEvidence['ci']['status'] = !ci
      ? 'not_run'
      : ci.conclusion === 'success' || ci.status === 'succeeded'
        ? 'passed'
        : ci.conclusion === 'none'
          ? 'not_run'
          : ci.conclusion || ci.status === 'failed'
            ? 'failed'
            : 'pending';
    const qaStatus: ApprovalEvidence['qa']['status'] = !qa
      ? 'not_run'
      : qa.status === 'PASSED'
        ? 'passed'
        : qa.status === 'SKIPPED'
          ? 'skipped'
          : 'failed';
    const dims = (review?.dimensions ?? {}) as Record<string, string>;
    const evidence: ApprovalEvidence = {
      action: params.action,
      environment: params.environment ?? null,
      changes: {
        files: files.length,
        summary: (codegen?.summary as string | undefined) ?? (pr?.title as string | undefined) ?? null,
        items: files.slice(0, 25).map((f) => `${f.action ?? f.status ?? 'modify'} ${f.path}`),
      },
      ci: { status: ciStatus, detail: (ci?.summary as string | undefined) ?? null },
      qa: { status: qaStatus, passed: Number(qa?.passed ?? 0), failed: Number(qa?.failed ?? 0) },
      review: {
        status: !review ? 'not_run' : Number(review.critical ?? 0) > 0 ? 'failed' : Number(review.high ?? 0) > 0 ? 'warning' : 'passed',
        critical: Number(review?.critical ?? 0),
        high: Number(review?.high ?? 0),
        security: dims.security ?? null,
      },
      migrations: files.some((f) => /migrat|schema\.prisma|\.sql$/i.test(f.path)),
      rollbackReady: params.action.startsWith('deploy.'),
      simulated: execution.mode === 'DEMO',
    };
    const risk = await this.risk.assess(execution.organizationId, evidence, { executionId: execution.id, userId: params.userId });
    return {
      evidence,
      risk,
      environment: params.environment ?? null,
      version: params.version ?? null,
      pullRequest: pr ? { number: pr.number ?? null, url: pr.url ?? null, title: pr.title ?? null } : null,
      ticket: ticket ? { key: ticket.key ?? null, url: ticket.url ?? null, summary: ticket.summary ?? null } : null,
      runTitle: execution.title,
    };
  }
}

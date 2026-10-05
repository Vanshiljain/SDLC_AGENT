import { Inject, Injectable, Logger } from '@nestjs/common';
import { invokeStructured, renderPrompt, riskAssessmentSchema, UsageTracker, type LlmProvider, type RiskAssessment } from '@forgeline/ai';
import type { RiskLevel } from '@forgeline/shared';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';
import { AgentRunsService } from '../ai/agent-runs.service';

export interface ApprovalEvidence {
  action: string;
  environment?: string | null;
  changes: { files: number; additions?: number; deletions?: number; summary?: string | null; items: string[] };
  ci: { status: 'passed' | 'failed' | 'not_run' | 'pending'; detail?: string | null };
  qa: { status: 'passed' | 'failed' | 'skipped' | 'not_run'; passed?: number; failed?: number };
  review: { status: 'passed' | 'warning' | 'failed' | 'not_run'; critical?: number; high?: number; security?: string | null };
  migrations: boolean;
  rollbackReady: boolean;
  simulated: boolean;
}

const LEVELS: RiskLevel[] = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'];

/**
 * Risk assessment shown on approval cards. A deterministic score is always
 * computed from evidence; when an LLM is configured it adds a narrative and
 * may raise (never lower) the level.
 */
@Injectable()
export class RiskAssessor {
  private readonly logger = new Logger(RiskAssessor.name);

  constructor(
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
    private readonly agentRuns: AgentRunsService,
  ) {}

  heuristic(e: ApprovalEvidence): RiskAssessment {
    let score = 0;
    const factors: RiskAssessment['factors'] = [];
    const add = (points: number, factor: string, impact: 'positive' | 'negative' | 'neutral') => {
      score += points;
      factors.push({ factor, impact });
    };
    if (e.action === 'deploy.production') add(2, 'Production environment', 'negative');
    if (e.action === 'pr.merge') add(1, 'Merging to the default branch', 'negative');
    if (e.ci.status === 'failed') add(3, 'CI failed', 'negative');
    else if (e.ci.status === 'passed') add(-1, 'CI passed', 'positive');
    else add(1, 'CI did not run', 'negative');
    if (e.qa.status === 'failed') add(3, `QA failed (${e.qa.failed ?? '?'} failing)`, 'negative');
    else if (e.qa.status === 'passed') add(-1, 'QA passed', 'positive');
    else add(1, `QA ${e.qa.status.replace('_', ' ')}`, 'negative');
    if ((e.review.critical ?? 0) > 0) add(4, `${e.review.critical} critical review finding(s)`, 'negative');
    if ((e.review.high ?? 0) > 0) add(2, `${e.review.high} high review finding(s)`, 'negative');
    if (e.review.security === 'failed') add(3, 'Security review failed', 'negative');
    if (e.changes.files > 30) add(2, `Large change (${e.changes.files} files)`, 'negative');
    else if (e.changes.files > 0 && e.changes.files <= 5) add(-1, `Small change (${e.changes.files} files)`, 'positive');
    if (e.migrations) add(2, 'Database migrations included', 'negative');
    if (e.rollbackReady) add(-1, 'Automatic rollback available', 'positive');
    const level: RiskLevel = score >= 7 ? 'CRITICAL' : score >= 4 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW';
    return {
      level,
      summary: `${level.charAt(0) + level.slice(1).toLowerCase()} risk based on ${factors.length} signals${e.simulated ? ' (demo data)' : ''}.`,
      factors,
      recommendation: level === 'CRITICAL' ? 'reject' : level === 'HIGH' ? 'approve_with_caution' : 'approve',
      mitigations: [
        ...(e.ci.status !== 'passed' ? ['Run CI to completion before approving'] : []),
        ...(e.qa.status !== 'passed' ? ['Run QA against the release candidate'] : []),
        ...((e.review.critical ?? 0) + (e.review.high ?? 0) > 0 ? ['Resolve high/critical review findings'] : []),
        ...(e.migrations ? ['Verify migrations are backward compatible'] : []),
      ],
    };
  }

  async assess(
    organizationId: string,
    e: ApprovalEvidence,
    ctx: { executionId?: string; userId?: string | null },
  ): Promise<RiskAssessment & { source: 'heuristic' | 'ai' }> {
    const base = this.heuristic(e);
    if (!this.llm.isConfigured() || e.simulated) return { ...base, source: 'heuristic' };
    const usage = new UsageTracker();
    const run = await this.agentRuns.start({
      organizationId,
      agentKey: 'release',
      task: `Risk assessment for ${e.action}`,
      executionId: ctx.executionId,
      userId: ctx.userId,
    });
    try {
      const messages = await renderPrompt('riskAssessment', {
        action: e.action,
        evidence: JSON.stringify({ ...e, heuristic: { level: base.level, factors: base.factors } }, null, 2),
      });
      const ai = await invokeStructured({
        model: this.llm.chatModel('fast'),
        schema: riskAssessmentSchema,
        name: 'risk_assessment',
        messages,
        usage,
        modelName: this.llm.modelName('fast'),
      });
      // The model may raise but never lower the deterministic level.
      const level = LEVELS[Math.max(LEVELS.indexOf(ai.level), LEVELS.indexOf(base.level))]!;
      await this.agentRuns.complete(organizationId, run, {
        usage,
        output: ai,
        summary: `${level} risk: ${ai.summary}`,
        executionId: ctx.executionId,
      });
      return {
        ...ai,
        level,
        factors: [...base.factors, ...ai.factors.filter((f) => !base.factors.some((b) => b.factor === f.factor))],
        source: 'ai',
      };
    } catch (err) {
      this.logger.warn({ err: (err as Error).message }, 'AI risk assessment failed; using heuristic');
      await this.agentRuns.fail(organizationId, run, err, usage);
      return { ...base, source: 'heuristic' };
    }
  }
}

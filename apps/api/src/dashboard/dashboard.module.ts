import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PrismaService } from '../common/prisma/prisma.service';
import { ProjectsService } from '../projects/projects.service';

const DAY = 86_400_000;

@Injectable()
export class DashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly projects: ProjectsService,
  ) {}

  /** Command Center: what is happening, what needs me, what failed, what shipped. */
  async commandCenter(auth: AuthContext) {
    const org = auth.organizationId;
    const since7 = new Date(Date.now() - 7 * DAY);
    const since30 = new Date(Date.now() - 30 * DAY);
    const [active, recent, failed, approvals, deployments, qa, reviews, integrations, agentActivity, runStats, projects, tokens] =
      await Promise.all([
        this.prisma.workflowExecution.findMany({
          where: { organizationId: org, status: { in: ['RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'COMPENSATING'] } },
          orderBy: { updatedAt: 'desc' },
          take: 12,
          select: {
            id: true,
            title: true,
            status: true,
            mode: true,
            startedAt: true,
            project: { select: { id: true, name: true, key: true } },
            steps: { orderBy: { position: 'asc' }, select: { stepKey: true, name: true, status: true, agent: true, summary: true } },
          },
        }),
        this.prisma.workflowExecution.findMany({
          where: { organizationId: org },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: {
            id: true,
            title: true,
            status: true,
            mode: true,
            createdAt: true,
            completedAt: true,
            template: true,
            project: { select: { name: true, key: true } },
          },
        }),
        this.prisma.workflowExecution.findMany({
          where: { organizationId: org, status: 'FAILED', completedAt: { gte: since7 } },
          orderBy: { completedAt: 'desc' },
          take: 6,
          select: { id: true, title: true, error: true, completedAt: true, project: { select: { name: true } } },
        }),
        this.prisma.approval.findMany({
          where: { organizationId: org, status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          take: 8,
          select: {
            id: true,
            title: true,
            action: true,
            riskLevel: true,
            createdAt: true,
            context: true,
            execution: { select: { id: true, title: true, mode: true } },
          },
        }),
        this.prisma.deployment.findMany({
          where: { organizationId: org },
          orderBy: { createdAt: 'desc' },
          take: 8,
          include: { environment: { select: { name: true, type: true } }, project: { select: { name: true, key: true } } },
        }),
        this.prisma.qATestRun.groupBy({
          by: ['status'],
          where: { organizationId: org, createdAt: { gte: since30 } },
          _count: true,
          _sum: { passed: true, failed: true, total: true },
        }),
        this.prisma.codeReview.aggregate({
          where: { organizationId: org, createdAt: { gte: since30 } },
          _count: true,
          _sum: { criticalCount: true, highCount: true, mediumCount: true, lowCount: true },
        }),
        this.prisma.integration.findMany({
          where: { organizationId: org, deletedAt: null },
          select: { id: true, provider: true, name: true, status: true, healthStatus: true, healthMessage: true, lastHealthCheckAt: true },
        }),
        this.prisma.agentRun.findMany({
          where: { organizationId: org },
          orderBy: { startedAt: 'desc' },
          take: 15,
          select: {
            id: true,
            task: true,
            status: true,
            summary: true,
            startedAt: true,
            durationMs: true,
            totalTokens: true,
            executionId: true,
            agent: { select: { key: true, name: true, kind: true } },
          },
        }),
        this.prisma.workflowExecution.groupBy({
          by: ['status'],
          where: { organizationId: org, createdAt: { gte: since30 } },
          _count: true,
        }),
        this.projects.list(auth),
        this.prisma.agentRun.aggregate({
          where: { organizationId: org, startedAt: { gte: since7 } },
          _sum: { totalTokens: true, llmCalls: true },
        }),
      ]);
    const finished = runStats.filter((s) => ['COMPLETED', 'FAILED', 'COMPENSATED'].includes(s.status)).reduce((a, s) => a + s._count, 0);
    const completed = runStats.find((s) => s.status === 'COMPLETED')?._count ?? 0;
    const qaTotals = qa.reduce(
      (a, s) => ({ runs: a.runs + s._count, passed: a.passed + (s._sum.passed ?? 0), failed: a.failed + (s._sum.failed ?? 0) }),
      { runs: 0, passed: 0, failed: 0 },
    );
    return {
      headline: {
        activeRuns: active.length,
        pendingApprovals: approvals.length,
        failedRuns7d: failed.length,
        successRate30d: finished ? completed / finished : null,
        deployments7d: deployments.filter((d) => d.createdAt >= since7).length,
        tokens7d: tokens._sum.totalTokens ?? 0,
      },
      activeRuns: active,
      recentRuns: recent,
      failedRuns: failed,
      pendingApprovals: approvals,
      deployments,
      qa: { byStatus: Object.fromEntries(qa.map((s) => [s.status, s._count])), ...qaTotals },
      reviews: {
        count: reviews._count,
        critical: reviews._sum.criticalCount ?? 0,
        high: reviews._sum.highCount ?? 0,
        medium: reviews._sum.mediumCount ?? 0,
        low: reviews._sum.lowCount ?? 0,
      },
      integrations,
      agentActivity,
      projects: projects.map((p) => ({ id: p.id, name: p.name, key: p.key, health: p.health })),
    };
  }

  /** Observability: run outcomes, durations, LLM usage, tool reliability. */
  async observability(auth: AuthContext, days: number) {
    const org = auth.organizationId;
    const since = new Date(Date.now() - days * DAY);
    const [runsDaily, tokensByModel, tokensByAgent, toolStats, stepDurations, errorKinds] = await Promise.all([
      this.prisma.$queryRaw<{ day: Date; status: string; count: bigint }[]>`
        SELECT date_trunc('day', "createdAt") AS day, status::text AS status, count(*)::bigint AS count
        FROM "WorkflowExecution" WHERE "organizationId" = ${org}::uuid AND "createdAt" >= ${since}
        GROUP BY 1, 2 ORDER BY 1`,
      this.prisma.agentRun.groupBy({
        by: ['model'],
        where: { organizationId: org, startedAt: { gte: since } },
        _sum: { promptTokens: true, completionTokens: true, totalTokens: true, llmCalls: true },
        _count: true,
      }),
      this.prisma.$queryRaw<{ agent: string; runs: bigint; tokens: bigint; failed: bigint; avg_ms: number | null }[]>`
        SELECT a.name AS agent, count(*)::bigint AS runs, coalesce(sum(r."totalTokens"), 0)::bigint AS tokens,
               count(*) FILTER (WHERE r.status = 'FAILED')::bigint AS failed, avg(r."durationMs")::float AS avg_ms
        FROM "AgentRun" r JOIN "Agent" a ON a.id = r."agentId"
        WHERE r."organizationId" = ${org}::uuid AND r."startedAt" >= ${since}
        GROUP BY a.name ORDER BY tokens DESC`,
      this.prisma.$queryRaw<{ tool: string; total: bigint; failed: bigint; avg_ms: number | null; p95_ms: number | null }[]>`
        SELECT tool, count(*)::bigint AS total, count(*) FILTER (WHERE status = 'FAILED')::bigint AS failed,
               avg("durationMs")::float AS avg_ms, percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs")::float AS p95_ms
        FROM "ToolExecution" WHERE "organizationId" = ${org}::uuid AND "startedAt" >= ${since}
        GROUP BY tool ORDER BY total DESC LIMIT 30`,
      this.prisma.$queryRaw<{ tool: string; p50: number | null; p95: number | null; n: bigint }[]>`
        SELECT s.tool, percentile_cont(0.5) WITHIN GROUP (ORDER BY s."durationMs")::float AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY s."durationMs")::float AS p95, count(*)::bigint AS n
        FROM "WorkflowExecutionStep" s JOIN "WorkflowExecution" e ON e.id = s."executionId"
        WHERE e."organizationId" = ${org}::uuid AND s."completedAt" >= ${since} AND s."durationMs" IS NOT NULL AND s.tool IS NOT NULL
        GROUP BY s.tool ORDER BY p95 DESC NULLS LAST LIMIT 20`,
      this.prisma.$queryRaw<{ kind: string; count: bigint }[]>`
        SELECT coalesce(error->>'kind', 'unknown') AS kind, count(*)::bigint AS count
        FROM "ToolExecution" WHERE "organizationId" = ${org}::uuid AND "startedAt" >= ${since} AND status = 'FAILED'
        GROUP BY 1 ORDER BY 2 DESC`,
    ]);
    const n = (v: bigint | number | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
    return {
      windowDays: days,
      runsDaily: runsDaily.map((r) => ({ day: r.day.toISOString().slice(0, 10), status: r.status, count: n(r.count) })),
      tokensByModel: tokensByModel.map((t) => ({
        model: t.model ?? 'unknown',
        runs: t._count,
        calls: n(t._sum.llmCalls),
        prompt: n(t._sum.promptTokens),
        completion: n(t._sum.completionTokens),
        total: n(t._sum.totalTokens),
      })),
      agents: tokensByAgent.map((a) => ({
        agent: a.agent,
        runs: n(a.runs),
        tokens: n(a.tokens),
        failed: n(a.failed),
        avgMs: a.avg_ms ? Math.round(a.avg_ms) : null,
      })),
      tools: toolStats.map((t) => ({
        tool: t.tool,
        total: n(t.total),
        failed: n(t.failed),
        errorRate: n(t.total) ? n(t.failed) / n(t.total) : 0,
        avgMs: t.avg_ms ? Math.round(t.avg_ms) : null,
        p95Ms: t.p95_ms ? Math.round(t.p95_ms) : null,
      })),
      stepLatency: stepDurations.map((s) => ({
        tool: s.tool,
        p50: s.p50 ? Math.round(s.p50) : null,
        p95: s.p95 ? Math.round(s.p95) : null,
        samples: n(s.n),
      })),
      errorKinds: errorKinds.map((e) => ({ kind: e.kind, count: n(e.count) })),
    };
  }
}

class ObservabilityQuery {
  @ApiPropertyOptional({ default: 14 }) @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(90) days?: number;
}

@ApiTags('dashboard')
@ApiBearerAuth()
@Controller()
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('dashboard')
  @ApiOperation({ summary: 'Command Center aggregate' })
  @RequirePermissions('project:read')
  get(@CurrentAuth() auth: AuthContext) {
    return this.dashboard.commandCenter(auth);
  }

  @Get('observability/summary')
  @ApiOperation({ summary: 'Run/LLM/tool observability metrics' })
  @RequirePermissions('observability:read')
  observability(@CurrentAuth() auth: AuthContext, @Query() q: ObservabilityQuery) {
    return this.dashboard.observability(auth, q.days ?? 14);
  }
}

@Module({ controllers: [DashboardController], providers: [DashboardService] })
export class DashboardModule {}

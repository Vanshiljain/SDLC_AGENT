import { Controller, Get, Global, Injectable, Module, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { PaginationQueryDto, paginate, skipTake } from '../common/pagination';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { PlannerService } from './planner.service';
import { OrchestratorService } from './orchestrator.service';

class RunsQuery extends PaginationQueryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(40) agent?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() executionId?: string;
}

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext) {
    const agents = await this.prisma.agent.findMany({ where: { OR: [{ organizationId: null }, { organizationId: auth.organizationId }], isEnabled: true }, orderBy: { kind: 'asc' } });
    const since = new Date(Date.now() - 30 * 86_400_000);
    const stats = await this.prisma.agentRun.groupBy({
      by: ['agentId', 'status'],
      where: { organizationId: auth.organizationId, startedAt: { gte: since } },
      _count: true,
      _sum: { totalTokens: true, durationMs: true },
    });
    const active = await this.prisma.agentRun.findMany({
      where: { organizationId: auth.organizationId, status: 'RUNNING', startedAt: { gte: new Date(Date.now() - 2 * 3_600_000) } },
      select: { id: true, agentId: true, task: true, startedAt: true, executionId: true, conversationId: true },
      orderBy: { startedAt: 'desc' },
    });
    return agents.map((a) => {
      const s = stats.filter((x) => x.agentId === a.id);
      const runs = s.reduce((acc, x) => acc + x._count, 0);
      const completed = s.filter((x) => x.status === 'COMPLETED').reduce((acc, x) => acc + x._count, 0);
      return {
        ...a,
        stats30d: {
          runs,
          successRate: runs ? completed / runs : null,
          tokens: s.reduce((acc, x) => acc + (x._sum.totalTokens ?? 0), 0),
          avgDurationMs: runs ? Math.round(s.reduce((acc, x) => acc + (x._sum.durationMs ?? 0), 0) / runs) : null,
        },
        active: active.filter((r) => r.agentId === a.id),
      };
    });
  }

  async runs(auth: AuthContext, q: RunsQuery) {
    const where = { organizationId: auth.organizationId, ...(q.executionId && { executionId: q.executionId }), ...(q.agent && { agent: { key: q.agent } }) };
    const [items, total] = await Promise.all([
      this.prisma.agentRun.findMany({ where, orderBy: { startedAt: 'desc' }, include: { agent: { select: { key: true, name: true, kind: true } } }, ...skipTake(q) }),
      this.prisma.agentRun.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async run(auth: AuthContext, id: string) {
    const r = await this.prisma.agentRun.findFirst({ where: { id, organizationId: auth.organizationId }, include: { agent: true } });
    if (!r) throw AppException.notFound('Agent run', id);
    return r;
  }
}

@ApiTags('agents')
@ApiBearerAuth()
@Controller('agents')
export class AgentsController {
  constructor(private readonly agents: AgentsService) {}

  @Get()
  @ApiOperation({ summary: 'Agents with 30-day statistics and currently active runs' })
  @RequirePermissions('workflow:read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.agents.list(auth);
  }

  @Get('runs')
  @RequirePermissions('workflow:read')
  runs(@CurrentAuth() auth: AuthContext, @Query() q: RunsQuery) {
    return this.agents.runs(auth, q);
  }

  @Get('runs/:id')
  @RequirePermissions('workflow:read')
  run(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.agents.run(auth, id);
  }
}

@Global()
@Module({
  controllers: [AgentsController],
  providers: [AgentsService, PlannerService, OrchestratorService],
  exports: [PlannerService, OrchestratorService],
})
export class AgentsModule {}

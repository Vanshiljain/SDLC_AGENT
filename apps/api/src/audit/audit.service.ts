import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@forgeline/database';
import type { AuditActorType, AuditStatus } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { redact } from '../common/redaction';
import { paginate, skipTake } from '../common/pagination';

export interface AuditEntry {
  organizationId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  actorId?: string | null;
  actorType?: AuditActorType;
  actorLabel?: string | null;
  projectId?: string | null;
  executionId?: string | null;
  tool?: string | null;
  status?: AuditStatus;
  input?: unknown;
  output?: unknown;
}

export interface AuditQuery {
  page: number;
  pageSize: number;
  action?: string;
  resourceType?: string;
  actorId?: string;
  projectId?: string;
  executionId?: string;
  status?: AuditStatus;
  from?: Date;
  to?: Date;
  search?: string;
}

/**
 * Append-only audit trail. Inputs/outputs are redacted; request metadata
 * (request id, IP, user agent) is taken from the correlation context.
 */
@Injectable()
export class AuditService {
  private readonly logger = new Logger(AuditService.name);

  constructor(private readonly prisma: PrismaService) {}

  async record(entry: AuditEntry, tx?: Prisma.TransactionClient): Promise<void> {
    const ctx = RequestContext.get();
    const data: Prisma.AuditLogUncheckedCreateInput = {
      organizationId: entry.organizationId,
      action: entry.action,
      resourceType: entry.resourceType,
      resourceId: entry.resourceId ?? null,
      actorId: entry.actorId === undefined ? (ctx.userId ?? null) : entry.actorId,
      actorType: entry.actorType ?? (ctx.userId ? 'USER' : 'SYSTEM'),
      actorLabel: entry.actorLabel ?? null,
      projectId: entry.projectId ?? null,
      executionId: entry.executionId ?? ctx.executionId ?? null,
      tool: entry.tool ?? null,
      status: entry.status ?? 'SUCCESS',
      input: entry.input === undefined ? undefined : (redact(entry.input, 0, 4000) as Prisma.InputJsonValue),
      output: entry.output === undefined ? undefined : (redact(entry.output, 0, 4000) as Prisma.InputJsonValue),
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent?.slice(0, 300) ?? null,
      requestId: ctx.requestId ?? null,
    };
    try {
      await (tx ?? this.prisma).auditLog.create({ data });
    } catch (err) {
      // Audit failures must be visible but must not break the business action that already happened.
      this.logger.error({ err, action: entry.action }, 'Failed to write audit log');
    }
  }

  async list(organizationId: string, q: AuditQuery) {
    const where: Prisma.AuditLogWhereInput = {
      organizationId,
      ...(q.action && { action: { startsWith: q.action } }),
      ...(q.resourceType && { resourceType: q.resourceType }),
      ...(q.actorId && { actorId: q.actorId }),
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.executionId && { executionId: q.executionId }),
      ...(q.status && { status: q.status }),
      ...((q.from || q.to) && { createdAt: { ...(q.from && { gte: q.from }), ...(q.to && { lte: q.to }) } }),
      ...(q.search && {
        OR: [
          { action: { contains: q.search, mode: 'insensitive' } },
          { resourceId: { contains: q.search } },
          { tool: { contains: q.search, mode: 'insensitive' } },
          { actorLabel: { contains: q.search, mode: 'insensitive' } },
        ],
      }),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, ...skipTake(q) }),
      this.prisma.auditLog.count({ where }),
    ]);
    const actorIds = [...new Set(items.map((i) => i.actorId).filter((x): x is string => Boolean(x)))];
    const actors = actorIds.length
      ? await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true, email: true } })
      : [];
    const byId = new Map(actors.map((a) => [a.id, a]));
    return paginate(
      items.map((i) => ({ ...i, actor: i.actorId ? (byId.get(i.actorId) ?? null) : null })),
      total,
      q,
    );
  }
}

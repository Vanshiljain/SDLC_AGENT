import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Prisma } from '@forgeline/database';
import type { ApprovalStatus, Permission, RiskLevel } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { EventBus } from '../events/event-bus.service';
import { AuthorizationService } from '../rbac/authorization.service';
import type { AuthContext } from '../common/auth/auth-context';
import { paginate, skipTake } from '../common/pagination';

export interface ApprovalRequest {
  organizationId: string;
  projectId: string | null;
  executionId: string;
  executionStepId: string;
  title: string;
  description?: string | null;
  action: string;
  riskLevel: RiskLevel;
  context: Record<string, unknown>;
  requiredPermission: Permission;
  allowSelfApproval: boolean;
  requestedById: string | null;
  expiresInMinutes?: number;
}

export interface ApprovalDecidedEvent {
  approvalId: string;
  executionId: string;
  stepId: string;
  approved: boolean;
  reason: string;
  [key: string]: unknown;
}

@Injectable()
export class ApprovalsService {
  private readonly logger = new Logger(ApprovalsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly authz: AuthorizationService,
  ) {}

  /** Idempotent: one approval per execution step. */
  async request(req: ApprovalRequest) {
    const existing = await this.prisma.approval.findUnique({ where: { executionStepId: req.executionStepId } });
    if (existing) return existing;
    const approval = await this.prisma.approval.create({
      data: {
        organizationId: req.organizationId,
        projectId: req.projectId,
        executionId: req.executionId,
        executionStepId: req.executionStepId,
        title: req.title,
        description: req.description,
        action: req.action,
        riskLevel: req.riskLevel,
        context: req.context as Prisma.InputJsonValue,
        requiredPermission: req.requiredPermission,
        allowSelfApproval: req.allowSelfApproval,
        requestedById: req.requestedById,
        expiresAt: req.expiresInMinutes ? new Date(Date.now() + req.expiresInMinutes * 60_000) : new Date(Date.now() + 7 * 86_400_000),
      },
    });
    await this.audit.record({ organizationId: req.organizationId, actorType: 'AGENT', actorId: req.requestedById, action: 'approval.requested', resourceType: 'approval', resourceId: approval.id, projectId: req.projectId, executionId: req.executionId, input: { action: req.action, risk: req.riskLevel } });
    await this.events.publish({
      type: 'approval.requested',
      organizationId: req.organizationId,
      projectId: req.projectId,
      executionId: req.executionId,
      data: { approvalId: approval.id, title: approval.title, status: 'PENDING', riskLevel: approval.riskLevel, executionId: req.executionId, action: req.action, requiredPermission: req.requiredPermission, requestedById: req.requestedById },
    });
    return approval;
  }

  async list(auth: AuthContext, q: { page: number; pageSize: number; status?: ApprovalStatus; projectId?: string }) {
    const where: Prisma.ApprovalWhereInput = { organizationId: auth.organizationId, ...(q.status && { status: q.status }), ...(q.projectId && { projectId: q.projectId }) };
    const [items, total] = await Promise.all([
      this.prisma.approval.findMany({
        where,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
        include: {
          execution: { select: { id: true, title: true, status: true, mode: true, project: { select: { id: true, name: true, key: true } } } },
          step: { select: { id: true, stepKey: true, name: true, tool: true } },
          requestedBy: { select: { id: true, name: true, email: true } },
          decidedBy: { select: { id: true, name: true, email: true } },
        },
        ...skipTake(q),
      }),
      this.prisma.approval.count({ where }),
    ]);
    const enriched = await Promise.all(items.map(async (a) => ({ ...a, canDecide: await this.canDecide(auth, a).then((r) => r.ok) })));
    return paginate(enriched, total, q);
  }

  async get(auth: AuthContext, id: string) {
    const a = await this.prisma.approval.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: {
        execution: { select: { id: true, title: true, status: true, mode: true, project: { select: { id: true, name: true, key: true } } } },
        step: { select: { id: true, stepKey: true, name: true, tool: true, input: true } },
        requestedBy: { select: { id: true, name: true, email: true } },
        decidedBy: { select: { id: true, name: true, email: true } },
      },
    });
    if (!a) throw AppException.notFound('Approval', id);
    const decide = await this.canDecide(auth, a);
    return { ...a, canDecide: decide.ok, cannotDecideReason: decide.ok ? null : decide.reason };
  }

  private async canDecide(auth: AuthContext, a: { status: string; requiredPermission: string; projectId: string | null; requestedById: string | null; allowSelfApproval: boolean }): Promise<{ ok: boolean; reason?: string }> {
    if (a.status !== 'PENDING') return { ok: false, reason: 'Already decided' };
    if (!a.allowSelfApproval && a.requestedById === auth.userId) return { ok: false, reason: 'Four-eyes policy: another approver must decide this request' };
    const has = await this.authz.hasPermission(auth.userId, auth.organizationId, a.requiredPermission as Permission, a.projectId);
    return has ? { ok: true } : { ok: false, reason: `Requires permission "${a.requiredPermission}"` };
  }

  async decide(auth: AuthContext, id: string, approve: boolean, comment?: string) {
    const a = await this.prisma.approval.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!a) throw AppException.notFound('Approval', id);
    if (a.expiresAt && a.expiresAt < new Date() && a.status === 'PENDING') {
      await this.expire(a.id);
      throw AppException.badRequest('This approval has expired', 'APPROVAL_EXPIRED');
    }
    const check = await this.canDecide(auth, a);
    if (!check.ok) {
      await this.audit.record({ organizationId: auth.organizationId, action: approve ? 'approval.approve' : 'approval.reject', resourceType: 'approval', resourceId: id, executionId: a.executionId, projectId: a.projectId, status: 'DENIED', output: { reason: check.reason } });
      throw a.status !== 'PENDING' ? AppException.conflict('This approval has already been decided', 'APPROVAL_DECIDED') : AppException.forbidden(check.reason, 'APPROVAL_NOT_ALLOWED');
    }
    const status = approve ? 'APPROVED' : 'REJECTED';
    // Conditional update: concurrent decisions cannot both win.
    const res = await this.prisma.approval.updateMany({
      where: { id, status: 'PENDING' },
      data: { status, decidedById: auth.userId, decidedAt: new Date(), decisionComment: comment?.slice(0, 2000) },
    });
    if (res.count !== 1) throw AppException.conflict('This approval has already been decided', 'APPROVAL_DECIDED');
    await this.audit.record({ organizationId: auth.organizationId, action: approve ? 'approval.approved' : 'approval.rejected', resourceType: 'approval', resourceId: id, executionId: a.executionId, projectId: a.projectId, input: { comment } });
    await this.publishDecision(a, approve, approve ? `Approved by ${auth.name}` : `Rejected by ${auth.name}${comment ? `: ${comment}` : ''}`);
    return this.get(auth, id);
  }

  private async publishDecision(a: { id: string; organizationId: string; projectId: string | null; executionId: string; executionStepId: string; title: string; riskLevel: string; requestedById: string | null }, approved: boolean, reason: string) {
    await this.events.publish<ApprovalDecidedEvent & { title: string; status: ApprovalStatus; riskLevel: string; requestedById: string | null }>({
      type: approved ? 'approval.granted' : 'approval.rejected',
      organizationId: a.organizationId,
      projectId: a.projectId,
      executionId: a.executionId,
      data: { approvalId: a.id, executionId: a.executionId, stepId: a.executionStepId, approved, reason, title: a.title, status: approved ? 'APPROVED' : 'REJECTED', riskLevel: a.riskLevel, requestedById: a.requestedById },
    });
  }

  async expire(id: string) {
    const a = await this.prisma.approval.findUnique({ where: { id } });
    if (!a) return;
    const res = await this.prisma.approval.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date() } });
    if (res.count === 1) {
      await this.audit.record({ organizationId: a.organizationId, actorType: 'SYSTEM', actorId: null, action: 'approval.expired', resourceType: 'approval', resourceId: id, executionId: a.executionId });
      await this.publishDecision(a, false, 'Approval expired');
    }
  }

  /** Cancel pending approvals of a cancelled run (no decision event — the run is already terminal). */
  async cancelForExecution(executionId: string) {
    await this.prisma.approval.updateMany({ where: { executionId, status: 'PENDING' }, data: { status: 'CANCELLED', decidedAt: new Date() } });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async expireOverdue(): Promise<void> {
    const overdue = await this.prisma.approval.findMany({ where: { status: 'PENDING', expiresAt: { lt: new Date() } }, select: { id: true }, take: 100 });
    for (const a of overdue) await this.expire(a.id).catch((err: unknown) => this.logger.error({ err }, 'Failed to expire approval'));
  }
}

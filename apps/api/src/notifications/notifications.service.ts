import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { NotificationType, Prisma } from '@forgeline/database';
import type { DomainEvent } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventBus } from '../events/event-bus.service';
import type { AuthContext } from '../common/auth/auth-context';

export interface NotificationPayload {
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  data?: Record<string, unknown>;
}

/** In-app notifications, created from domain events and delivered live per user. */
@Injectable()
export class NotificationsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
  ) {}

  onModuleInit(): void {
    this.events.on<{ approvalId: string; title: string; riskLevel: string; requestedById?: string | null }>('approval.requested', (e) => this.onApprovalRequested(e));
    this.events.on<{ approvalId: string; title: string; requestedById?: string | null; reason?: string }>('approval.granted', (e) => this.onApprovalDecided(e, true));
    this.events.on<{ approvalId: string; title: string; requestedById?: string | null; reason?: string }>('approval.rejected', (e) => this.onApprovalDecided(e, false));
    this.events.on<{ title: string; triggeredById?: string | null }>('workflow.completed', (e) => this.onRunFinished(e, true));
    this.events.on<{ title: string; triggeredById?: string | null; error?: { message?: string } | null }>('workflow.failed', (e) => this.onRunFinished(e, false));
    this.events.on<{ environment: string; version: string; simulated: boolean }>('deployment.completed', (e) =>
      this.notifyProject(e.organizationId, e.projectId ?? null, { type: 'DEPLOYMENT', title: `Deployed ${e.data.version} to ${e.data.environment}${e.data.simulated ? ' (simulated)' : ''}`, link: e.executionId ? `/executions/${e.executionId}` : '/deployments' }),
    );
    this.events.on<{ environment: string; version: string; message?: string }>('deployment.failed', (e) =>
      this.notifyProject(e.organizationId, e.projectId ?? null, { type: 'DEPLOYMENT', title: `Deployment of ${e.data.version} to ${e.data.environment} failed`, body: e.data.message ?? null, link: e.executionId ? `/executions/${e.executionId}` : '/deployments' }),
    );
  }

  async create(organizationId: string, userId: string, p: NotificationPayload) {
    const n = await this.prisma.notification.create({
      data: { organizationId, userId, type: p.type, title: p.title.slice(0, 300), body: p.body?.slice(0, 4000) ?? null, link: p.link ?? null, data: (p.data ?? {}) as Prisma.InputJsonValue },
    });
    await this.events.publish({ type: 'notification.created', organizationId, userId, data: { id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, createdAt: n.createdAt.toISOString() } });
    return n;
  }

  /** Project members plus organization owners/admins. Returns the number notified. */
  async notifyProject(organizationId: string, projectId: string | null, p: NotificationPayload, exclude: string[] = []): Promise<number> {
    const [admins, members] = await Promise.all([
      this.prisma.membership.findMany({ where: { organizationId, role: { in: ['OWNER', 'ADMIN'] } }, select: { userId: true } }),
      projectId ? this.prisma.projectMember.findMany({ where: { projectId }, select: { userId: true } }) : Promise.resolve([]),
    ]);
    const recipients = [...new Set([...admins, ...members].map((m) => m.userId))].filter((u) => !exclude.includes(u));
    for (const userId of recipients) await this.create(organizationId, userId, p);
    return recipients.length;
  }

  private async onApprovalRequested(e: DomainEvent<{ approvalId: string; title: string; riskLevel: string; requestedById?: string | null }>) {
    await this.notifyProject(e.organizationId, e.projectId ?? null, {
      type: 'APPROVAL_REQUESTED',
      title: `Approval needed: ${e.data.title}`,
      body: `Risk: ${e.data.riskLevel}`,
      link: `/approvals?focus=${e.data.approvalId}`,
      data: { approvalId: e.data.approvalId },
    });
  }

  private async onApprovalDecided(e: DomainEvent<{ approvalId: string; title: string; requestedById?: string | null; reason?: string }>, approved: boolean) {
    if (!e.data.requestedById) return;
    await this.create(e.organizationId, e.data.requestedById, {
      type: 'APPROVAL_DECIDED',
      title: `${approved ? 'Approved' : 'Rejected'}: ${e.data.title}`,
      body: e.data.reason ?? null,
      link: e.executionId ? `/executions/${e.executionId}` : '/approvals',
    });
  }

  private async onRunFinished(e: DomainEvent<{ title: string; triggeredById?: string | null; error?: { message?: string } | null }>, ok: boolean) {
    if (!e.data.triggeredById) return;
    await this.create(e.organizationId, e.data.triggeredById, {
      type: ok ? 'WORKFLOW_COMPLETED' : 'WORKFLOW_FAILED',
      title: `${ok ? 'Completed' : 'Failed'}: ${e.data.title}`,
      body: ok ? null : (e.data.error?.message ?? null),
      link: `/executions/${e.executionId}`,
    });
  }

  list(auth: AuthContext, unreadOnly: boolean) {
    return this.prisma.notification.findMany({
      where: { organizationId: auth.organizationId, userId: auth.userId, ...(unreadOnly && { readAt: null }) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async unreadCount(auth: AuthContext) {
    return { unread: await this.prisma.notification.count({ where: { organizationId: auth.organizationId, userId: auth.userId, readAt: null } }) };
  }

  async markRead(auth: AuthContext, ids: string[] | 'all') {
    await this.prisma.notification.updateMany({
      where: { organizationId: auth.organizationId, userId: auth.userId, readAt: null, ...(ids !== 'all' && { id: { in: ids } }) },
      data: { readAt: new Date() },
    });
    return this.unreadCount(auth);
  }
}

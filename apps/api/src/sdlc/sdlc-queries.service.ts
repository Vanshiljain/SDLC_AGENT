import { Injectable } from '@nestjs/common';
import type { Prisma, TaskPriority, TaskStatus } from '@forgeline/database';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import type { AuthContext } from '../common/auth/auth-context';
import { paginate, skipTake } from '../common/pagination';

type Page = { page: number; pageSize: number };
const PROJECT = { select: { id: true, name: true, key: true } } as const;

/** Read models (and simple writes) for SDLC entities shown in the product. */
@Injectable()
export class SdlcQueriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async codeGenerations(auth: AuthContext, q: Page & { projectId?: string }) {
    const where: Prisma.CodeGenerationWhereInput = { organizationId: auth.organizationId, ...(q.projectId && { projectId: q.projectId }) };
    const [items, total] = await Promise.all([
      this.prisma.codeGeneration.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          requirement: true,
          status: true,
          branch: true,
          baseBranch: true,
          commitSha: true,
          prUrl: true,
          prNumber: true,
          iterations: true,
          simulated: true,
          createdAt: true,
          executionId: true,
          validation: true,
          project: PROJECT,
        },
        ...skipTake(q),
      }),
      this.prisma.codeGeneration.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async codeGeneration(auth: AuthContext, id: string) {
    const cg = await this.prisma.codeGeneration.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: { project: PROJECT, repository: { select: { fullName: true, url: true } } },
    });
    if (!cg) throw AppException.notFound('Code generation', id);
    // File contents can be large; return paths/actions plus the unified diff.
    const files = (cg.files as { path: string; action: string; explanation?: string }[]).map((f) => ({
      path: f.path,
      action: f.action,
      explanation: f.explanation ?? null,
    }));
    return { ...cg, files };
  }

  async codeReviews(auth: AuthContext, q: Page & { projectId?: string }) {
    const where: Prisma.CodeReviewWhereInput = { organizationId: auth.organizationId, ...(q.projectId && { projectId: q.projectId }) };
    const [items, total] = await Promise.all([
      this.prisma.codeReview.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          verdict: true,
          riskLevel: true,
          criticalCount: true,
          highCount: true,
          mediumCount: true,
          lowCount: true,
          prNumber: true,
          prUrl: true,
          postedToProvider: true,
          simulated: true,
          createdAt: true,
          executionId: true,
          dimensions: true,
          project: PROJECT,
        },
        ...skipTake(q),
      }),
      this.prisma.codeReview.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async codeReview(auth: AuthContext, id: string) {
    const r = await this.prisma.codeReview.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: { project: PROJECT, repository: { select: { fullName: true, url: true } } },
    });
    if (!r) throw AppException.notFound('Code review', id);
    return r;
  }

  async qaRuns(auth: AuthContext, q: Page & { projectId?: string; status?: string }) {
    const where: Prisma.QATestRunWhereInput = {
      organizationId: auth.organizationId,
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.status && { status: q.status as never }),
    };
    const [items, total, last30] = await Promise.all([
      this.prisma.qATestRun.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          type: true,
          status: true,
          total: true,
          passed: true,
          failed: true,
          skipped: true,
          durationMs: true,
          ref: true,
          simulated: true,
          createdAt: true,
          executionId: true,
          project: PROJECT,
        },
        ...skipTake(q),
      }),
      this.prisma.qATestRun.count({ where }),
      this.prisma.qATestRun.groupBy({
        by: ['status'],
        where: { organizationId: auth.organizationId, createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } },
        _count: true,
      }),
    ]);
    return { ...paginate(items, total, q), summary: Object.fromEntries(last30.map((r) => [r.status, r._count])) };
  }

  async qaRun(auth: AuthContext, id: string) {
    const r = await this.prisma.qATestRun.findFirst({ where: { id, organizationId: auth.organizationId }, include: { project: PROJECT } });
    if (!r) throw AppException.notFound('QA run', id);
    return r;
  }

  async deployments(auth: AuthContext, q: Page & { projectId?: string; environment?: string; status?: string }) {
    const where: Prisma.DeploymentWhereInput = {
      organizationId: auth.organizationId,
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.status && { status: q.status as never }),
      ...(q.environment && { environment: { name: q.environment } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.deployment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        include: { environment: { select: { id: true, name: true, type: true, url: true } }, project: PROJECT },
        ...skipTake(q),
      }),
      this.prisma.deployment.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  /** Current state per environment across projects (release board). */
  async environmentsBoard(auth: AuthContext) {
    const envs = await this.prisma.environment.findMany({
      where: { organizationId: auth.organizationId, project: { deletedAt: null } },
      include: {
        project: PROJECT,
        deployments: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            version: true,
            status: true,
            createdAt: true,
            completedAt: true,
            simulated: true,
            executionId: true,
            commitSha: true,
          },
        },
      },
      orderBy: [{ projectId: 'asc' }, { type: 'asc' }],
    });
    return envs.map((e) => ({
      id: e.id,
      name: e.name,
      type: e.type,
      url: e.url,
      requiresApproval: e.requiresApproval,
      project: e.project,
      current: e.deployments.find((d) => d.status === 'SUCCEEDED') ?? null,
      recent: e.deployments,
    }));
  }

  async deployment(auth: AuthContext, id: string) {
    const d = await this.prisma.deployment.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: { environment: true, project: PROJECT, execution: { select: { id: true, title: true, status: true } } },
    });
    if (!d) throw AppException.notFound('Deployment', id);
    return d;
  }

  async documents(auth: AuthContext, q: Page & { projectId?: string; search?: string }) {
    const where: Prisma.DocumentWhereInput = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.search && { title: { contains: q.search, mode: 'insensitive' } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.document.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          title: true,
          type: true,
          externalProvider: true,
          externalUrl: true,
          version: true,
          updatedAt: true,
          executionId: true,
          project: PROJECT,
        },
        ...skipTake(q),
      }),
      this.prisma.document.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async document(auth: AuthContext, id: string) {
    const d = await this.prisma.document.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      include: { project: PROJECT },
    });
    if (!d) throw AppException.notFound('Document', id);
    return d;
  }

  async saveDocument(
    auth: AuthContext,
    id: string | null,
    data: { title: string; content: string; type?: string; projectId?: string | null },
  ) {
    if (data.projectId) {
      const p = await this.prisma.project.findFirst({
        where: { id: data.projectId, organizationId: auth.organizationId, deletedAt: null },
      });
      if (!p) throw AppException.notFound('Project', data.projectId);
    }
    const doc = id
      ? await this.prisma.document.update({
          where: { id: (await this.document(auth, id)).id },
          data: { title: data.title, content: data.content, ...(data.type && { type: data.type as never }), version: { increment: 1 } },
        })
      : await this.prisma.document.create({
          data: {
            organizationId: auth.organizationId,
            projectId: data.projectId ?? null,
            title: data.title,
            content: data.content,
            type: (data.type ?? 'OTHER') as never,
            createdById: auth.userId,
          },
        });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: id ? 'document.updated' : 'document.created',
      resourceType: 'document',
      resourceId: doc.id,
      projectId: doc.projectId,
    });
    return doc;
  }

  async tasks(auth: AuthContext, q: Page & { projectId?: string; status?: string }) {
    const where: Prisma.TaskWhereInput = {
      organizationId: auth.organizationId,
      deletedAt: null,
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.status && { status: q.status as TaskStatus }),
    };
    const [items, total] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        include: { project: PROJECT, execution: { select: { id: true, title: true, status: true } } },
        ...skipTake(q),
      }),
      this.prisma.task.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async saveTask(
    auth: AuthContext,
    id: string | null,
    data: {
      title?: string;
      description?: string;
      status?: TaskStatus;
      priority?: TaskPriority;
      projectId?: string;
      assigneeId?: string | null;
    },
  ) {
    if (id) {
      const existing = await this.prisma.task.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
      if (!existing) throw AppException.notFound('Task', id);
      const t = await this.prisma.task.update({
        where: { id },
        data: {
          ...(data.title && { title: data.title }),
          ...(data.description !== undefined && { description: data.description }),
          ...(data.status && { status: data.status }),
          ...(data.priority && { priority: data.priority }),
          ...(data.assigneeId !== undefined && { assigneeId: data.assigneeId }),
        },
      });
      await this.audit.record({
        organizationId: auth.organizationId,
        action: 'task.updated',
        resourceType: 'task',
        resourceId: id,
        projectId: t.projectId,
        input: data,
      });
      return t;
    }
    if (!data.projectId || !data.title) throw AppException.badRequest('projectId and title are required');
    const p = await this.prisma.project.findFirst({ where: { id: data.projectId, organizationId: auth.organizationId, deletedAt: null } });
    if (!p) throw AppException.notFound('Project', data.projectId);
    const count = await this.prisma.task.count({ where: { projectId: p.id, externalProvider: 'FORGELINE' } });
    const t = await this.prisma.task.create({
      data: {
        organizationId: auth.organizationId,
        projectId: p.id,
        title: data.title,
        description: data.description,
        status: data.status ?? 'TODO',
        priority: data.priority ?? 'MEDIUM',
        externalProvider: 'FORGELINE',
        externalKey: `${p.key}-T${count + 1}`,
        createdById: auth.userId,
        assigneeId: data.assigneeId ?? null,
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'task.created',
      resourceType: 'task',
      resourceId: t.id,
      projectId: p.id,
    });
    return t;
  }
}

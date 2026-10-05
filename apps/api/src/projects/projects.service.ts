import { Injectable } from '@nestjs/common';
import type { Prisma } from '@forgeline/database';
import type { ProjectContext, ProjectSettings, RepositorySettings, SmokeTestDefinition } from '@forgeline/integrations';
import type { EnvironmentType, ProjectRole } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { ConnectionResolver } from '../integrations/connection-resolver.service';
import type { AuthContext } from '../common/auth/auth-context';
import { slugify } from '../organizations/organizations.service';
import type {
  CreateProjectDto,
  EnvironmentDto,
  LinkRepositoryDto,
  UpdateEnvironmentDto,
  UpdateProjectDto,
  UpdateRepositoryDto,
} from './projects.dto';

const DEFAULT_ENVIRONMENTS: { name: string; type: EnvironmentType; requiresApproval: boolean }[] = [
  { name: 'development', type: 'DEVELOPMENT', requiresApproval: false },
  { name: 'staging', type: 'STAGING', requiresApproval: false },
  { name: 'production', type: 'PRODUCTION', requiresApproval: true },
];

/** Sensible defaults for Node/TypeScript repositories; overridable per repository. */
export const DEFAULT_REPOSITORY_SETTINGS: RepositorySettings = {
  installCommand: 'npm ci --no-audit --no-fund',
  lintCommand: 'npm run lint --if-present',
  typecheckCommand: 'npx --no-install tsc --noEmit -p .',
  testCommand: 'npm test --if-present',
  buildCommand: 'npm run build --if-present',
  ciWorkflow: 'ci.yml',
  deployWorkflow: 'deploy.yml',
};

@Injectable()
export class ProjectsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly connections: ConnectionResolver,
  ) {}

  async list(auth: AuthContext) {
    const projects = await this.prisma.project.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null },
      include: {
        team: { select: { id: true, name: true } },
        repositories: { where: { deletedAt: null }, select: { id: true, fullName: true, defaultBranch: true, language: true } },
        environments: { select: { id: true, name: true, type: true, url: true } },
        _count: { select: { executions: true, tasks: true } },
      },
      orderBy: { name: 'asc' },
    });
    const ids = projects.map((p) => p.id);
    const since = new Date(Date.now() - 14 * 86_400_000);
    const [runStats, lastDeploys, pendingApprovals, lastQa] = await Promise.all([
      this.prisma.workflowExecution.groupBy({
        by: ['projectId', 'status'],
        where: { projectId: { in: ids }, createdAt: { gte: since } },
        _count: true,
      }),
      this.prisma.deployment.findMany({
        where: { projectId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        distinct: ['projectId', 'environmentId'],
        include: { environment: { select: { name: true, type: true } } },
      }),
      this.prisma.approval.groupBy({ by: ['projectId'], where: { projectId: { in: ids }, status: 'PENDING' }, _count: true }),
      this.prisma.qATestRun.findMany({
        where: { projectId: { in: ids } },
        orderBy: { createdAt: 'desc' },
        distinct: ['projectId'],
        select: { projectId: true, status: true, passed: true, failed: true, createdAt: true },
      }),
    ]);
    return projects.map((p) => {
      const stats = runStats.filter((r) => r.projectId === p.id);
      const total = stats.reduce((s, r) => s + r._count, 0);
      const failed = stats.filter((r) => r.status === 'FAILED').reduce((s, r) => s + r._count, 0);
      const completed = stats.filter((r) => r.status === 'COMPLETED').reduce((s, r) => s + r._count, 0);
      const deploys = lastDeploys
        .filter((d) => d.projectId === p.id)
        .map((d) => ({
          environment: d.environment.name,
          type: d.environment.type,
          status: d.status,
          version: d.version,
          at: d.createdAt,
          simulated: d.simulated,
        }));
      const qa = lastQa.find((q) => q.projectId === p.id) ?? null;
      const successRate = completed + failed ? completed / (completed + failed) : null;
      const score = this.healthScore(
        successRate,
        deploys.map((d) => d.status),
        qa?.status ?? null,
      );
      return {
        ...p,
        health: {
          score,
          status: score === null ? 'unknown' : score >= 80 ? 'healthy' : score >= 50 ? 'at_risk' : 'critical',
          runs14d: total,
          successRate,
          pendingApprovals: pendingApprovals.find((a) => a.projectId === p.id)?._count ?? 0,
          lastQa: qa,
          deployments: deploys,
        },
      };
    });
  }

  private healthScore(successRate: number | null, deployStatuses: string[], qaStatus: string | null): number | null {
    const parts: number[] = [];
    if (successRate !== null) parts.push(successRate * 100);
    if (deployStatuses.length) parts.push((deployStatuses.filter((s) => s === 'SUCCEEDED').length / deployStatuses.length) * 100);
    if (qaStatus) parts.push(qaStatus === 'PASSED' ? 100 : qaStatus === 'SKIPPED' ? 70 : 20);
    return parts.length ? Math.round(parts.reduce((a, b) => a + b, 0) / parts.length) : null;
  }

  async get(auth: AuthContext, id: string) {
    const project = await this.prisma.project.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      include: {
        team: true,
        repositories: { where: { deletedAt: null } },
        environments: { orderBy: { type: 'asc' } },
        members: { include: { user: { select: { id: true, name: true, email: true, avatarUrl: true } } } },
      },
    });
    if (!project) throw AppException.notFound('Project', id);
    const latestDeployments = await this.prisma.deployment.findMany({
      where: { projectId: id },
      orderBy: { createdAt: 'desc' },
      distinct: ['environmentId'],
    });
    return { ...project, latestDeployments };
  }

  async create(auth: AuthContext, dto: CreateProjectDto) {
    if (dto.teamId) {
      const team = await this.prisma.team.findFirst({ where: { id: dto.teamId, organizationId: auth.organizationId, deletedAt: null } });
      if (!team) throw AppException.notFound('Team', dto.teamId);
    }
    const project = await this.prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          organizationId: auth.organizationId,
          name: dto.name,
          key: dto.key,
          slug: slugify(dto.name),
          description: dto.description,
          teamId: dto.teamId,
          settings: { jiraProjectKey: dto.key, ...dto.settings } as Prisma.InputJsonValue,
        },
      });
      await tx.projectMember.create({ data: { projectId: p.id, userId: auth.userId, role: 'MAINTAINER' } });
      if (dto.createDefaultEnvironments !== false) {
        await tx.environment.createMany({
          data: DEFAULT_ENVIRONMENTS.map((e) => ({
            ...e,
            organizationId: auth.organizationId,
            projectId: p.id,
            smokeTests: [{ name: 'Health endpoint', path: '/health', expectStatus: 200 }],
          })),
        });
      }
      return p;
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'project.created',
      resourceType: 'project',
      resourceId: project.id,
      projectId: project.id,
      input: { name: dto.name, key: dto.key },
    });
    return project;
  }

  async update(auth: AuthContext, id: string, dto: UpdateProjectDto) {
    const existing = await this.prisma.project.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
    if (!existing) throw AppException.notFound('Project', id);
    const settings = dto.settings ? { ...(existing.settings as object), ...dto.settings } : undefined;
    const project = await this.prisma.project.update({
      where: { id },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.description !== undefined && { description: dto.description }),
        ...(dto.teamId !== undefined && { teamId: dto.teamId }),
        ...(settings && { settings: settings as Prisma.InputJsonValue }),
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'project.updated',
      resourceType: 'project',
      resourceId: id,
      projectId: id,
      input: dto,
    });
    return project;
  }

  async remove(auth: AuthContext, id: string) {
    const res = await this.prisma.project.updateMany({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!res.count) throw AppException.notFound('Project', id);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'project.deleted',
      resourceType: 'project',
      resourceId: id,
      projectId: id,
    });
  }

  // ── Members ──
  async upsertMember(auth: AuthContext, projectId: string, userId: string, role: ProjectRole) {
    const member = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId: auth.organizationId, userId } },
    });
    if (!member) throw AppException.badRequest('User is not a member of this organization', 'NOT_A_MEMBER');
    const pm = await this.prisma.projectMember.upsert({
      where: { projectId_userId: { projectId, userId } },
      create: { projectId, userId, role },
      update: { role },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'project.member_set',
      resourceType: 'project',
      resourceId: projectId,
      projectId,
      input: { userId, role },
    });
    return pm;
  }

  async removeMember(auth: AuthContext, projectId: string, userId: string) {
    await this.prisma.projectMember.deleteMany({ where: { projectId, userId } });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'project.member_removed',
      resourceType: 'project',
      resourceId: projectId,
      projectId,
      input: { userId },
    });
  }

  // ── Repositories ──
  async linkRepository(auth: AuthContext, projectId: string, dto: LinkRepositoryDto) {
    const [owner, name] = dto.fullName.split('/') as [string, string];
    // Verify the repository is reachable with the organization's GitHub connection.
    const gh = await this.connections.github(auth.organizationId);
    const remote = await gh.getRepository(owner, name);
    const integration = await this.connections.findActive(auth.organizationId, 'GITHUB');
    const repo = await this.prisma.repository.upsert({
      where: { projectId_provider_fullName: { projectId, provider: 'github', fullName: remote.full_name } },
      create: {
        organizationId: auth.organizationId,
        projectId,
        integrationId: integration?.id,
        owner: remote.owner.login,
        name: remote.name,
        fullName: remote.full_name,
        defaultBranch: remote.default_branch,
        url: remote.html_url,
        externalId: String(remote.id),
        language: remote.language ?? null,
        settings: { ...DEFAULT_REPOSITORY_SETTINGS, ...dto.settings } as Prisma.InputJsonValue,
      },
      update: {
        deletedAt: null,
        defaultBranch: remote.default_branch,
        url: remote.html_url,
        language: remote.language ?? null,
        ...(dto.settings && { settings: { ...DEFAULT_REPOSITORY_SETTINGS, ...dto.settings } as Prisma.InputJsonValue }),
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'repository.linked',
      resourceType: 'repository',
      resourceId: repo.id,
      projectId,
      input: { fullName: remote.full_name },
    });
    return repo;
  }

  async updateRepository(auth: AuthContext, projectId: string, repositoryId: string, dto: UpdateRepositoryDto) {
    const repo = await this.prisma.repository.findFirst({
      where: { id: repositoryId, projectId, organizationId: auth.organizationId, deletedAt: null },
    });
    if (!repo) throw AppException.notFound('Repository', repositoryId);
    const updated = await this.prisma.repository.update({
      where: { id: repositoryId },
      data: {
        ...(dto.defaultBranch && { defaultBranch: dto.defaultBranch }),
        ...(dto.settings && { settings: { ...(repo.settings as object), ...dto.settings } as Prisma.InputJsonValue }),
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'repository.updated',
      resourceType: 'repository',
      resourceId: repositoryId,
      projectId,
      input: dto,
    });
    return updated;
  }

  async unlinkRepository(auth: AuthContext, projectId: string, repositoryId: string) {
    const res = await this.prisma.repository.updateMany({
      where: { id: repositoryId, projectId, organizationId: auth.organizationId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!res.count) throw AppException.notFound('Repository', repositoryId);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'repository.unlinked',
      resourceType: 'repository',
      resourceId: repositoryId,
      projectId,
    });
  }

  listRepositories(auth: AuthContext) {
    return this.prisma.repository.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null, project: { deletedAt: null } },
      include: { project: { select: { id: true, name: true, key: true } } },
      orderBy: { fullName: 'asc' },
    });
  }

  // ── Environments ──
  async createEnvironment(auth: AuthContext, projectId: string, dto: EnvironmentDto) {
    const env = await this.prisma.environment.create({
      data: {
        organizationId: auth.organizationId,
        projectId,
        name: dto.name,
        type: dto.type,
        url: dto.url,
        healthCheckPath: dto.healthCheckPath ?? '/health',
        requiresApproval: dto.requiresApproval ?? dto.type === 'PRODUCTION',
        smokeTests: (dto.smokeTests ?? []) as unknown as Prisma.InputJsonValue,
        config: (dto.config ?? {}) as Prisma.InputJsonValue,
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'environment.created',
      resourceType: 'environment',
      resourceId: env.id,
      projectId,
      input: dto,
    });
    return env;
  }

  async updateEnvironment(auth: AuthContext, projectId: string, environmentId: string, dto: UpdateEnvironmentDto) {
    const env = await this.prisma.environment.findFirst({ where: { id: environmentId, projectId, organizationId: auth.organizationId } });
    if (!env) throw AppException.notFound('Environment', environmentId);
    if (env.type === 'PRODUCTION' && dto.requiresApproval === false) {
      throw AppException.badRequest('Production deployments always require approval', 'POLICY_LOCKED');
    }
    const updated = await this.prisma.environment.update({
      where: { id: environmentId },
      data: {
        ...(dto.url !== undefined && { url: dto.url }),
        ...(dto.healthCheckPath && { healthCheckPath: dto.healthCheckPath }),
        ...(dto.requiresApproval !== undefined && { requiresApproval: dto.requiresApproval }),
        ...(dto.smokeTests && { smokeTests: dto.smokeTests as unknown as Prisma.InputJsonValue }),
        ...(dto.config && { config: dto.config as Prisma.InputJsonValue }),
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'environment.updated',
      resourceType: 'environment',
      resourceId: environmentId,
      projectId,
      input: dto,
    });
    return updated;
  }
}

/** Builds the ProjectContext that tools receive (non-secret configuration only). */
@Injectable()
export class ProjectContextService {
  constructor(private readonly prisma: PrismaService) {}

  async load(organizationId: string, projectId: string | null | undefined): Promise<ProjectContext | null> {
    if (!projectId) return null;
    const p = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId, deletedAt: null },
      include: { repositories: { where: { deletedAt: null }, orderBy: { createdAt: 'asc' }, take: 1 }, environments: true },
    });
    if (!p) return null;
    const repo = p.repositories[0];
    return {
      id: p.id,
      name: p.name,
      key: p.key,
      slug: p.slug,
      description: p.description,
      settings: (p.settings ?? {}) as ProjectSettings,
      repository: repo
        ? {
            id: repo.id,
            owner: repo.owner,
            name: repo.name,
            fullName: repo.fullName,
            defaultBranch: repo.defaultBranch,
            url: repo.url,
            settings: { ...DEFAULT_REPOSITORY_SETTINGS, ...(repo.settings as RepositorySettings) },
          }
        : null,
      environments: p.environments.map((e) => ({
        id: e.id,
        name: e.name,
        type: e.type,
        url: e.url,
        healthCheckPath: e.healthCheckPath,
        smokeTests: (e.smokeTests ?? []) as unknown as SmokeTestDefinition[],
        requiresApproval: e.requiresApproval,
        config: (e.config ?? {}) as Record<string, unknown>,
      })),
    };
  }
}

import { Injectable } from '@nestjs/common';
import { resolvePermissions, type OrgRole, type Permission, type ProjectRole } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import type { AuthContext } from '../common/auth/auth-context';

export interface PrincipalPermissions {
  userId: string;
  organizationId: string;
  orgRole: OrgRole;
  projectRole: ProjectRole | null;
  permissions: Set<Permission>;
}

/**
 * Central authorization: tenant isolation + RBAC. Every service and the tool
 * executor go through here; agents never get more than the user's permissions.
 */
@Injectable()
export class AuthorizationService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fresh permission resolution from the database (used for agent/tool execution). */
  async resolve(userId: string, organizationId: string, projectId?: string | null): Promise<PrincipalPermissions | null> {
    const membership = await this.prisma.membership.findUnique({
      where: { organizationId_userId: { organizationId, userId } },
      include: { user: { select: { isActive: true, deletedAt: true } } },
    });
    if (!membership || !membership.user.isActive || membership.user.deletedAt) return null;
    let projectRole: ProjectRole | null = null;
    if (projectId) {
      const pm = await this.prisma.projectMember.findUnique({ where: { projectId_userId: { projectId, userId } } });
      projectRole = (pm?.role as ProjectRole | undefined) ?? null;
    }
    return {
      userId,
      organizationId,
      orgRole: membership.role as OrgRole,
      projectRole,
      permissions: resolvePermissions(membership.role as OrgRole, projectRole),
    };
  }

  async hasPermission(userId: string, organizationId: string, permission: Permission, projectId?: string | null): Promise<boolean> {
    const p = await this.resolve(userId, organizationId, projectId);
    return Boolean(p?.permissions.has(permission));
  }

  /** Ensure the project exists inside the caller's organization (tenant isolation). */
  async assertProjectInOrg(organizationId: string, projectId: string): Promise<void> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!project) throw AppException.notFound('Project', projectId);
  }

  async assertPermission(auth: AuthContext, permission: Permission, projectId?: string | null): Promise<void> {
    if (projectId) await this.assertProjectInOrg(auth.organizationId, projectId);
    if (auth.permissions.has(permission)) return;
    if (projectId) {
      const p = await this.resolve(auth.userId, auth.organizationId, projectId);
      if (p?.permissions.has(permission)) return;
    }
    throw AppException.forbidden(`Missing permission "${permission}"${projectId ? ' for this project' : ''}`, 'PERMISSION_DENIED');
  }

  async effectivePermissions(auth: AuthContext, projectId?: string | null): Promise<Permission[]> {
    if (!projectId) return [...auth.permissions];
    const p = await this.resolve(auth.userId, auth.organizationId, projectId);
    return p ? [...p.permissions] : [];
  }
}

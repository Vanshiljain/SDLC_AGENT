import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { Request } from 'express';
import { HEADER_ORGANIZATION, ORG_ROLE_PERMISSIONS, type OrgRole } from '@forgeline/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AppException } from '../errors';
import { RequestContext } from '../context/request-context';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';
import { AuthorizationService } from '../../rbac/authorization.service';
import { AuditService } from '../../audit/audit.service';
import { ALLOW_NO_ORG, IS_PUBLIC, REQUIRED_PERMISSIONS, type AuthContext, type PermissionRequirement } from './auth-context';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  name: string;
  typ: 'access';
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Verifies the bearer access token and resolves the active organization
 * membership (X-Organization-Id header, else the first membership).
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;
    const req = context.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw AppException.unauthorized();
    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(header.slice(7), { secret: this.config.jwt.secret, algorithms: ['HS256'] });
    } catch {
      throw AppException.unauthorized('Invalid or expired access token', 'TOKEN_INVALID');
    }
    if (payload.typ !== 'access') throw AppException.unauthorized('Invalid token type', 'TOKEN_INVALID');

    const requestedOrg = req.headers[HEADER_ORGANIZATION];
    const orgId = typeof requestedOrg === 'string' && UUID_RE.test(requestedOrg) ? requestedOrg : undefined;
    const membership = await this.prisma.membership.findFirst({
      where: { userId: payload.sub, ...(orgId ? { organizationId: orgId } : {}), organization: { deletedAt: null } },
      include: { organization: { select: { isDemo: true } }, user: { select: { isActive: true, deletedAt: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });

    const allowNoOrg = this.reflector.getAllAndOverride<boolean>(ALLOW_NO_ORG, [context.getHandler(), context.getClass()]);
    if (!membership) {
      if (orgId) throw AppException.forbidden('You are not a member of this organization', 'NOT_A_MEMBER');
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.isActive || user.deletedAt) throw AppException.unauthorized('Account disabled', 'ACCOUNT_DISABLED');
      if (!allowNoOrg) throw AppException.forbidden('An active organization is required', 'NO_ORGANIZATION');
      req.auth = { userId: user.id, email: user.email, name: user.name, organizationId: null };
      RequestContext.set({ userId: user.id });
      return true;
    }
    if (!membership.user.isActive || membership.user.deletedAt) throw AppException.unauthorized('Account disabled', 'ACCOUNT_DISABLED');

    const auth: AuthContext = {
      userId: payload.sub,
      email: membership.user.email,
      name: membership.user.name,
      organizationId: membership.organizationId,
      orgRole: membership.role as OrgRole,
      permissions: new Set(ORG_ROLE_PERMISSIONS[membership.role as OrgRole]),
      isDemoOrg: membership.organization.isDemo,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
    };
    req.auth = auth;
    RequestContext.set({ userId: auth.userId, organizationId: auth.organizationId, ip: req.ip, userAgent: auth.userAgent });
    return true;
  }
}

/** Enforces @RequirePermissions (org-level, or project-level when projectFrom is set). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<Request>();
    const requirement = this.reflector.getAllAndOverride<PermissionRequirement | undefined>(REQUIRED_PERMISSIONS, [context.getHandler(), context.getClass()]);
    if (!requirement) return true;
    const auth = req.auth;
    if (!auth || auth.organizationId === null) throw AppException.forbidden('An active organization is required', 'NO_ORGANIZATION');
    let projectId: string | undefined;
    if (requirement.projectFrom) {
      const [source, key] = requirement.projectFrom.split(':') as ['param' | 'body' | 'query', string];
      const bag = source === 'param' ? req.params : source === 'body' ? (req.body as Record<string, unknown>) : (req.query as Record<string, unknown>);
      const value = bag?.[key];
      projectId = typeof value === 'string' && value ? value : undefined;
      if (projectId && !UUID_RE.test(projectId)) throw AppException.badRequest('Invalid project id');
    }
    for (const permission of requirement.permissions) {
      try {
        await this.authz.assertPermission(auth as AuthContext, permission, projectId);
      } catch (err) {
        // Denied attempts are part of the audit trail (route template only — never query strings or bodies).
        if (err instanceof AppException && err.getStatus() === 403) {
          await this.audit
            .record({
              organizationId: auth.organizationId,
              actorId: auth.userId,
              actorType: 'USER',
              action: 'permission.denied',
              resourceType: 'route',
              resourceId: null,
              projectId: projectId ?? null,
              status: 'DENIED',
              input: { method: req.method, route: (req.route as { path?: string } | undefined)?.path ?? req.path, permission },
            })
            .catch(() => undefined);
        }
        throw err;
      }
    }
    return true;
  }
}

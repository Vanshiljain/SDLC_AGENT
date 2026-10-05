import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common';
import type { OrgRole, Permission } from '@forgeline/shared';
import { AppException } from '../errors';

/** Authenticated principal attached to every request by JwtAuthGuard. */
export interface AuthContext {
  userId: string;
  email: string;
  name: string;
  organizationId: string;
  orgRole: OrgRole;
  /** Organization-level permissions (project roles are resolved per project). */
  permissions: ReadonlySet<Permission>;
  isDemoOrg: boolean;
  ip?: string;
  userAgent?: string;
}

/** Authenticated user without an active organization (e.g. /auth/me before joining one). */
export interface AuthUserOnly {
  userId: string;
  email: string;
  name: string;
  organizationId: null;
}

declare module 'express' {
  interface Request {
    auth?: AuthContext | AuthUserOnly;
    rawBody?: Buffer;
  }
}

export const IS_PUBLIC = 'forgeline:isPublic';
export const ALLOW_NO_ORG = 'forgeline:allowNoOrg';
export const REQUIRED_PERMISSIONS = 'forgeline:permissions';

/** Skip authentication (login, webhooks, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
/** Authenticated but no organization membership required. */
export const AllowNoOrganization = () => SetMetadata(ALLOW_NO_ORG, true);

export interface PermissionRequirement {
  permissions: Permission[];
  /** Where to find a projectId for project-scoped checks, e.g. "param:projectId", "body:projectId", "query:projectId". */
  projectFrom?: string;
}

export const RequirePermissions = (permissions: Permission | Permission[], options: { projectFrom?: string } = {}) =>
  SetMetadata(REQUIRED_PERMISSIONS, { permissions: Array.isArray(permissions) ? permissions : [permissions], projectFrom: options.projectFrom } satisfies PermissionRequirement);

export const CurrentAuth = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext => {
  const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext | AuthUserOnly }>();
  if (!req.auth || req.auth.organizationId === null) throw AppException.forbidden('An active organization is required', 'NO_ORGANIZATION');
  return req.auth as AuthContext;
});

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthContext | AuthUserOnly => {
  const req = ctx.switchToHttp().getRequest<{ auth?: AuthContext | AuthUserOnly }>();
  if (!req.auth) throw AppException.unauthorized();
  return req.auth;
});

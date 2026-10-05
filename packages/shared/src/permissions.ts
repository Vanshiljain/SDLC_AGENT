import type { OrgRole, ProjectRole } from './enums';

/**
 * Fine-grained permissions. Roles map to permission sets; guards and the tool
 * executor check permissions, never roles directly.
 */
export const PERMISSIONS = [
  'org:read',
  'org:manage',
  'members:manage',
  'project:read',
  'project:create',
  'project:manage',
  'integration:read',
  'integration:manage',
  'workflow:read',
  'workflow:manage',
  'workflow:execute',
  'approval:decide',
  'agent:use',
  'ticket:write',
  'code:write',
  'code:merge',
  'qa:run',
  'deploy:development',
  'deploy:staging',
  'deploy:production',
  'docs:write',
  'knowledge:read',
  'knowledge:manage',
  'notify:send',
  'audit:read',
  'observability:read',
  'settings:manage',
  'infrastructure:destroy',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const READ_ONLY: Permission[] = [
  'org:read',
  'project:read',
  'integration:read',
  'workflow:read',
  'knowledge:read',
];

const CONTRIBUTOR: Permission[] = [
  ...READ_ONLY,
  'project:create',
  'workflow:manage',
  'workflow:execute',
  'approval:decide',
  'agent:use',
  'ticket:write',
  'code:write',
  'qa:run',
  'deploy:development',
  'deploy:staging',
  'docs:write',
  'knowledge:manage',
  'notify:send',
  'observability:read',
];

export const ORG_ROLE_PERMISSIONS: Record<OrgRole, readonly Permission[]> = {
  OWNER: PERMISSIONS,
  ADMIN: PERMISSIONS.filter((p) => p !== 'infrastructure:destroy'),
  MEMBER: CONTRIBUTOR,
  VIEWER: READ_ONLY,
};

/**
 * Project roles grant additional permissions scoped to one project. They are
 * unioned with the organization role's permissions.
 */
export const PROJECT_ROLE_PERMISSIONS: Record<ProjectRole, readonly Permission[]> = {
  MAINTAINER: [
    ...CONTRIBUTOR,
    'project:manage',
    'code:merge',
    'deploy:production',
    'audit:read',
  ],
  DEVELOPER: CONTRIBUTOR,
  VIEWER: READ_ONLY,
};

export function resolvePermissions(
  orgRole: OrgRole,
  projectRole?: ProjectRole | null,
): Set<Permission> {
  const result = new Set<Permission>(ORG_ROLE_PERMISSIONS[orgRole]);
  if (projectRole) {
    for (const p of PROJECT_ROLE_PERMISSIONS[projectRole]) result.add(p);
  }
  return result;
}

export function hasPermission(
  orgRole: OrgRole,
  permission: Permission,
  projectRole?: ProjectRole | null,
): boolean {
  return resolvePermissions(orgRole, projectRole).has(permission);
}

/** Permission required to deploy to an environment type. */
export function deployPermissionFor(
  envType: 'DEVELOPMENT' | 'STAGING' | 'PRODUCTION',
): Permission {
  switch (envType) {
    case 'PRODUCTION':
      return 'deploy:production';
    case 'STAGING':
      return 'deploy:staging';
    default:
      return 'deploy:development';
  }
}

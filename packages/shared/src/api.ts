import type { OrgRole } from './enums';
import type { Permission } from './permissions';

/** Common API response shapes used by the web client. */

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  code?: string;
  details?: unknown;
  requestId?: string;
}

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
}

export interface MembershipSummary {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrgRole;
  isDemo: boolean;
}

export interface SessionResponse {
  accessToken: string;
  expiresIn: number;
  user: AuthUser;
  memberships: MembershipSummary[];
}

export interface MeResponse {
  user: AuthUser;
  memberships: MembershipSummary[];
  activeOrganizationId: string | null;
  permissions: Permission[];
}

export const HEADER_ORGANIZATION = 'x-organization-id';
export const HEADER_REQUEST_ID = 'x-request-id';
export const HEADER_CSRF = 'x-csrf-token';
export const COOKIE_REFRESH = 'fl_refresh';
export const COOKIE_CSRF = 'fl_csrf';

import { Inject, Injectable } from '@nestjs/common';
import { Prisma, type OrgRole as DbOrgRole } from '@forgeline/database';
import type { OrgRole } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { EncryptionService } from '../common/crypto/encryption.service';
import { AuditService } from '../audit/audit.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import type { AuthContext } from '../common/auth/auth-context';

export interface OrganizationSettings {
  /** Production approvals must be decided by someone other than the requester. */
  fourEyesProduction: boolean;
  /** Default ticket system for new projects. */
  defaultTicketProvider: 'JIRA' | 'TRELLO';
  /** Data retention for execution logs, days. */
  logRetentionDays: number;
}

export const DEFAULT_ORG_SETTINGS: OrganizationSettings = {
  fourEyesProduction: true,
  defaultTicketProvider: 'JIRA',
  logRetentionDays: 90,
};

export function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'workspace'
  );
}

const ROLE_RANK: Record<OrgRole, number> = { OWNER: 4, ADMIN: 3, MEMBER: 2, VIEWER: 1 };

@Injectable()
export class OrganizationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async createWithOwner(tx: Prisma.TransactionClient, params: { name: string; ownerId: string; isDemo?: boolean }) {
    let slug = slugify(params.name);
    for (let i = 0; await tx.organization.findUnique({ where: { slug } }); i++) {
      slug = `${slugify(params.name).slice(0, 40)}-${EncryptionService.randomToken(3)
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '')}${i}`;
    }
    const org = await tx.organization.create({
      data: { name: params.name, slug, isDemo: params.isDemo ?? false, settings: DEFAULT_ORG_SETTINGS as unknown as Prisma.InputJsonValue },
    });
    await tx.membership.create({ data: { organizationId: org.id, userId: params.ownerId, role: 'OWNER' } });
    return org;
  }

  async get(auth: AuthContext) {
    const org = await this.prisma.organization.findFirstOrThrow({ where: { id: auth.organizationId, deletedAt: null } });
    return { ...org, settings: this.settingsOf(org.settings) };
  }

  settingsOf(raw: unknown): OrganizationSettings {
    return { ...DEFAULT_ORG_SETTINGS, ...(raw && typeof raw === 'object' ? (raw as Partial<OrganizationSettings>) : {}) };
  }

  async update(auth: AuthContext, patch: { name?: string; settings?: Partial<OrganizationSettings> }) {
    const current = await this.get(auth);
    const settings = { ...current.settings, ...patch.settings };
    const org = await this.prisma.organization.update({
      where: { id: auth.organizationId },
      data: { ...(patch.name && { name: patch.name }), settings: settings as unknown as Prisma.InputJsonValue },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'organization.updated',
      resourceType: 'organization',
      resourceId: org.id,
      input: patch,
    });
    return { ...org, settings };
  }

  async listMembers(auth: AuthContext) {
    const members = await this.prisma.membership.findMany({
      where: { organizationId: auth.organizationId },
      include: { user: { select: { id: true, email: true, name: true, avatarUrl: true, lastLoginAt: true, isActive: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const invitations = await this.prisma.invitation.findMany({
      where: { organizationId: auth.organizationId, acceptedAt: null, revokedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, email: true, role: true, expiresAt: true, createdAt: true },
    });
    return { members: members.map((m) => ({ id: m.id, role: m.role, joinedAt: m.createdAt, user: m.user })), invitations };
  }

  private assertCanAssign(auth: AuthContext, role: OrgRole): void {
    if (ROLE_RANK[role] > ROLE_RANK[auth.orgRole])
      throw AppException.forbidden('You cannot grant a role higher than your own', 'ROLE_ESCALATION');
  }

  async invite(auth: AuthContext, email: string, role: OrgRole) {
    this.assertCanAssign(auth, role);
    const normalized = email.trim().toLowerCase();
    const existingMember = await this.prisma.membership.findFirst({
      where: { organizationId: auth.organizationId, user: { email: normalized } },
    });
    if (existingMember) throw AppException.conflict('This person is already a member', 'ALREADY_MEMBER');
    const token = EncryptionService.randomToken(32);
    const invitation = await this.prisma.invitation.create({
      data: {
        organizationId: auth.organizationId,
        email: normalized,
        role: role as DbOrgRole,
        tokenHash: EncryptionService.sha256(token),
        invitedById: auth.userId,
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'member.invited',
      resourceType: 'invitation',
      resourceId: invitation.id,
      input: { email: normalized, role },
    });
    // The raw token is shown exactly once to the inviting admin (no email infrastructure dependency).
    return {
      id: invitation.id,
      email: normalized,
      role,
      expiresAt: invitation.expiresAt,
      inviteUrl: `${this.config.webAppUrl}/accept-invite?token=${token}`,
    };
  }

  async revokeInvitation(auth: AuthContext, id: string) {
    const res = await this.prisma.invitation.updateMany({
      where: { id, organizationId: auth.organizationId, acceptedAt: null },
      data: { revokedAt: new Date() },
    });
    if (!res.count) throw AppException.notFound('Invitation', id);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'member.invitation_revoked',
      resourceType: 'invitation',
      resourceId: id,
    });
  }

  async updateMemberRole(auth: AuthContext, membershipId: string, role: OrgRole) {
    const m = await this.prisma.membership.findFirst({ where: { id: membershipId, organizationId: auth.organizationId } });
    if (!m) throw AppException.notFound('Member', membershipId);
    this.assertCanAssign(auth, role);
    if (ROLE_RANK[m.role as OrgRole] > ROLE_RANK[auth.orgRole])
      throw AppException.forbidden('You cannot change the role of a more privileged member');
    if (m.role === 'OWNER' && role !== 'OWNER') await this.assertAnotherOwner(auth.organizationId, m.userId);
    const updated = await this.prisma.membership.update({ where: { id: m.id }, data: { role: role as DbOrgRole } });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'member.role_changed',
      resourceType: 'membership',
      resourceId: m.id,
      input: { from: m.role, to: role, userId: m.userId },
    });
    return updated;
  }

  async removeMember(auth: AuthContext, membershipId: string) {
    const m = await this.prisma.membership.findFirst({ where: { id: membershipId, organizationId: auth.organizationId } });
    if (!m) throw AppException.notFound('Member', membershipId);
    if (ROLE_RANK[m.role as OrgRole] > ROLE_RANK[auth.orgRole]) throw AppException.forbidden('You cannot remove a more privileged member');
    if (m.role === 'OWNER') await this.assertAnotherOwner(auth.organizationId, m.userId);
    await this.prisma.$transaction([
      this.prisma.projectMember.deleteMany({ where: { userId: m.userId, project: { organizationId: auth.organizationId } } }),
      this.prisma.teamMember.deleteMany({ where: { userId: m.userId, team: { organizationId: auth.organizationId } } }),
      this.prisma.membership.delete({ where: { id: m.id } }),
    ]);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'member.removed',
      resourceType: 'membership',
      resourceId: m.id,
      input: { userId: m.userId },
    });
  }

  private async assertAnotherOwner(organizationId: string, excludingUserId: string) {
    const owners = await this.prisma.membership.count({ where: { organizationId, role: 'OWNER', userId: { not: excludingUserId } } });
    if (!owners) throw AppException.badRequest('An organization must keep at least one owner', 'LAST_OWNER');
  }

  // ── Teams ──
  listTeams(auth: AuthContext) {
    return this.prisma.team.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null },
      include: {
        members: { include: { user: { select: { id: true, name: true, email: true } } } },
        _count: { select: { projects: true } },
      },
      orderBy: { name: 'asc' },
    });
  }

  async createTeam(auth: AuthContext, name: string, description?: string) {
    const team = await this.prisma.team.create({ data: { organizationId: auth.organizationId, name, slug: slugify(name), description } });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'team.created',
      resourceType: 'team',
      resourceId: team.id,
      input: { name },
    });
    return team;
  }

  async setTeamMembers(auth: AuthContext, teamId: string, userIds: string[]) {
    const team = await this.prisma.team.findFirst({ where: { id: teamId, organizationId: auth.organizationId, deletedAt: null } });
    if (!team) throw AppException.notFound('Team', teamId);
    const valid = await this.prisma.membership.findMany({
      where: { organizationId: auth.organizationId, userId: { in: userIds } },
      select: { userId: true },
    });
    await this.prisma.$transaction([
      this.prisma.teamMember.deleteMany({ where: { teamId } }),
      this.prisma.teamMember.createMany({ data: valid.map((v) => ({ teamId, userId: v.userId })) }),
    ]);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'team.members_updated',
      resourceType: 'team',
      resourceId: teamId,
      input: { userIds: valid.map((v) => v.userId) },
    });
    return this.prisma.team.findUnique({
      where: { id: teamId },
      include: { members: { include: { user: { select: { id: true, name: true, email: true } } } } },
    });
  }

  async deleteTeam(auth: AuthContext, teamId: string) {
    const res = await this.prisma.team.updateMany({
      where: { id: teamId, organizationId: auth.organizationId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (!res.count) throw AppException.notFound('Team', teamId);
    await this.audit.record({ organizationId: auth.organizationId, action: 'team.deleted', resourceType: 'team', resourceId: teamId });
  }
}

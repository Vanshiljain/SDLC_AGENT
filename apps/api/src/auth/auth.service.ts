import { Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as argon2 from 'argon2';
import { createHmac, randomUUID } from 'node:crypto';
import type { MembershipSummary, OrgRole, SessionResponse } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { EncryptionService } from '../common/crypto/encryption.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { AuditService } from '../audit/audit.service';
import { OrganizationsService } from '../organizations/organizations.service';
import type { AccessTokenPayload } from '../common/auth/guards';
import type { AcceptInviteDto, LoginDto, RegisterDto } from './auth.dto';

export interface IssuedSession extends SessionResponse {
  refreshToken: string;
  refreshExpiresAt: Date;
}

const ARGON_OPTIONS: argon2.Options = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);
  /** Pre-computed hash so unknown-user logins take as long as real ones. */
  private dummyHash?: Promise<string>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly audit: AuditService,
    private readonly organizations: OrganizationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, ARGON_OPTIONS);
  }

  /** Refresh tokens are opaque; stored as HMAC(JWT_REFRESH_SECRET, token). */
  private hashRefreshToken(token: string): string {
    return createHmac('sha256', this.config.jwt.refreshSecret).update(token).digest('hex');
  }

  async register(dto: RegisterDto, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
    const existing = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (existing) throw AppException.conflict('An account with this email already exists', 'EMAIL_TAKEN');
    const passwordHash = await this.hashPassword(dto.password);
    const user = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.create({ data: { email: dto.email, name: dto.name, passwordHash } });
      await this.organizations.createWithOwner(tx, {
        name: dto.organizationName ?? `${dto.name.split(' ')[0]}'s workspace`,
        ownerId: u.id,
      });
      return u;
    });
    const session = await this.issueSession(user.id, meta);
    const orgId = session.memberships[0]?.organizationId;
    if (orgId)
      await this.audit.record({
        organizationId: orgId,
        action: 'auth.register',
        resourceType: 'user',
        resourceId: user.id,
        actorId: user.id,
      });
    return session;
  }

  async login(dto: LoginDto, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    this.dummyHash ??= this.hashPassword(EncryptionService.randomToken());
    const hash = user?.passwordHash ?? (await this.dummyHash);
    const ok = await argon2.verify(hash, dto.password).catch(() => false);
    if (!user || !ok || !user.passwordHash) {
      if (user) {
        const m = await this.prisma.membership.findFirst({ where: { userId: user.id } });
        if (m)
          await this.audit.record({
            organizationId: m.organizationId,
            action: 'auth.login',
            resourceType: 'user',
            resourceId: user.id,
            actorId: user.id,
            status: 'FAILURE',
          });
      }
      throw AppException.unauthorized('Invalid email or password', 'INVALID_CREDENTIALS');
    }
    if (!user.isActive || user.deletedAt) throw AppException.unauthorized('Account disabled', 'ACCOUNT_DISABLED');
    if (argon2.needsRehash(user.passwordHash, ARGON_OPTIONS)) {
      await this.prisma.user.update({ where: { id: user.id }, data: { passwordHash: await this.hashPassword(dto.password) } });
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const session = await this.issueSession(user.id, meta);
    for (const m of session.memberships.slice(0, 1)) {
      await this.audit.record({
        organizationId: m.organizationId,
        action: 'auth.login',
        resourceType: 'user',
        resourceId: user.id,
        actorId: user.id,
      });
    }
    return session;
  }

  async acceptInvite(dto: AcceptInviteDto, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
    const invite = await this.prisma.invitation.findUnique({ where: { tokenHash: EncryptionService.sha256(dto.token) } });
    if (!invite || invite.acceptedAt || invite.revokedAt || invite.expiresAt < new Date()) {
      throw AppException.badRequest('This invitation is invalid or has expired', 'INVITE_INVALID');
    }
    const passwordHash = await this.hashPassword(dto.password);
    const userId = await this.prisma.$transaction(async (tx) => {
      let user = await tx.user.findUnique({ where: { email: invite.email } });
      if (user?.passwordHash)
        throw AppException.conflict(
          'An account with this email already exists — sign in and accept from your workspace list',
          'EMAIL_TAKEN',
        );
      user = user
        ? await tx.user.update({ where: { id: user.id }, data: { name: dto.name, passwordHash } })
        : await tx.user.create({ data: { email: invite.email, name: dto.name, passwordHash } });
      await tx.membership.upsert({
        where: { organizationId_userId: { organizationId: invite.organizationId, userId: user.id } },
        create: { organizationId: invite.organizationId, userId: user.id, role: invite.role },
        update: { role: invite.role },
      });
      const claimed = await tx.invitation.updateMany({ where: { id: invite.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      if (claimed.count !== 1) throw AppException.conflict('Invitation already used', 'INVITE_USED');
      return user.id;
    });
    await this.audit.record({
      organizationId: invite.organizationId,
      action: 'member.joined',
      resourceType: 'user',
      resourceId: userId,
      actorId: userId,
      output: { role: invite.role },
    });
    return this.issueSession(userId, meta);
  }

  async memberships(userId: string): Promise<MembershipSummary[]> {
    const rows = await this.prisma.membership.findMany({
      where: { userId, organization: { deletedAt: null } },
      include: { organization: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((m) => ({
      organizationId: m.organizationId,
      organizationName: m.organization.name,
      organizationSlug: m.organization.slug,
      role: m.role as OrgRole,
      isDemo: m.organization.isDemo,
    }));
  }

  async issueSession(userId: string, meta: { ip?: string; userAgent?: string }, familyId: string = randomUUID()): Promise<IssuedSession> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const payload: AccessTokenPayload = { sub: user.id, email: user.email, name: user.name, typ: 'access' };
    const accessToken = await this.jwt.signAsync(payload, {
      secret: this.config.jwt.secret,
      expiresIn: this.config.jwt.accessTtlSeconds,
      algorithm: 'HS256',
    });
    const refreshToken = EncryptionService.randomToken(48);
    const refreshExpiresAt = new Date(Date.now() + this.config.jwt.refreshTtlDays * 86_400_000);
    await this.prisma.refreshToken.create({
      data: {
        userId,
        tokenHash: this.hashRefreshToken(refreshToken),
        familyId,
        expiresAt: refreshExpiresAt,
        ip: meta.ip,
        userAgent: meta.userAgent?.slice(0, 300),
      },
    });
    return {
      accessToken,
      expiresIn: this.config.jwt.accessTtlSeconds,
      user: { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl },
      memberships: await this.memberships(user.id),
      refreshToken,
      refreshExpiresAt,
    };
  }

  /**
   * Rotating refresh tokens with reuse detection: presenting an already-rotated
   * token revokes the whole family (likely theft).
   */
  async refresh(token: string, meta: { ip?: string; userAgent?: string }): Promise<IssuedSession> {
    const tokenHash = this.hashRefreshToken(token);
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash } });
    if (!existing) throw AppException.unauthorized('Invalid refresh token', 'REFRESH_INVALID');
    if (existing.revokedAt) {
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      this.logger.warn({ userId: existing.userId, familyId: existing.familyId }, 'Refresh token reuse detected; family revoked');
      const m = await this.prisma.membership.findFirst({ where: { userId: existing.userId } });
      if (m)
        await this.audit.record({
          organizationId: m.organizationId,
          action: 'auth.refresh_reuse_detected',
          resourceType: 'user',
          resourceId: existing.userId,
          actorId: existing.userId,
          status: 'DENIED',
        });
      throw AppException.unauthorized('Session revoked', 'REFRESH_REUSED');
    }
    if (existing.expiresAt < new Date()) throw AppException.unauthorized('Session expired', 'REFRESH_EXPIRED');
    const user = await this.prisma.user.findUnique({ where: { id: existing.userId } });
    if (!user || !user.isActive || user.deletedAt) throw AppException.unauthorized('Account disabled', 'ACCOUNT_DISABLED');

    // Claim atomically so two concurrent refreshes cannot both rotate.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: existing.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) throw AppException.unauthorized('Session revoked', 'REFRESH_REUSED');
    const session = await this.issueSession(existing.userId, meta, existing.familyId);
    const next = await this.prisma.refreshToken.findUnique({ where: { tokenHash: this.hashRefreshToken(session.refreshToken) } });
    await this.prisma.refreshToken.update({ where: { id: existing.id }, data: { replacedById: next?.id } });
    return session;
  }

  async logout(token: string | undefined): Promise<void> {
    if (!token) return;
    const existing = await this.prisma.refreshToken.findUnique({ where: { tokenHash: this.hashRefreshToken(token) } });
    if (existing)
      await this.prisma.refreshToken.updateMany({
        where: { familyId: existing.familyId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!user.passwordHash || !(await argon2.verify(user.passwordHash, current)))
      throw AppException.badRequest('Current password is incorrect', 'INVALID_CREDENTIALS');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(next) } }),
      this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
  }
}

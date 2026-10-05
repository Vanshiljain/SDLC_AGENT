import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response, CookieOptions } from 'express';
import { COOKIE_CSRF, COOKIE_REFRESH, HEADER_CSRF, type MeResponse, type SessionResponse } from '@forgeline/shared';
import { AllowNoOrganization, CurrentUser, Public, type AuthContext, type AuthUserOnly } from '../common/auth/auth-context';
import { AppException } from '../common/errors';
import { EncryptionService } from '../common/crypto/encryption.service';
import { APP_CONFIG, loadConfig, type AppConfig } from '../config/configuration';
import { AuthService, type IssuedSession } from './auth.service';
import { AcceptInviteDto, ChangePasswordDto, LoginDto, RegisterDto } from './auth.dto';

// Stricter limit for credential endpoints (AUTH_RATE_LIMIT_MAX per minute per client), resolved from config at runtime.
let authLimit: number | undefined;
const AUTH_THROTTLE = { default: { limit: () => (authLimit ??= loadConfig().rateLimit.authMax), ttl: 60_000 } };

/**
 * Session endpoints. The access token is returned in the body (kept in memory
 * by the SPA); the refresh token is an HttpOnly SameSite=Strict cookie scoped
 * to /api/auth, and refreshing requires a CSRF double-submit header.
 */
@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private cookieBase(): CookieOptions {
    return { secure: this.config.cookies.secure, sameSite: 'strict', domain: this.config.cookies.domain, path: '/api/auth' };
  }

  private writeSession(res: Response, session: IssuedSession): SessionResponse {
    res.cookie(COOKIE_REFRESH, session.refreshToken, { ...this.cookieBase(), httpOnly: true, expires: session.refreshExpiresAt });
    // CSRF token must be readable by the SPA (double-submit), so it is not HttpOnly and lives at path "/".
    res.cookie(COOKIE_CSRF, EncryptionService.randomToken(24), { ...this.cookieBase(), path: '/', httpOnly: false, expires: session.refreshExpiresAt });
    const { refreshToken: _r, refreshExpiresAt: _e, ...body } = session;
    return body;
  }

  private meta(req: Request) {
    return { ip: req.ip, userAgent: req.headers['user-agent'] };
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('register')
  @ApiOperation({ summary: 'Create an account and workspace' })
  async register(@Body() dto: RegisterDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SessionResponse> {
    return this.writeSession(res, await this.auth.register(dto, this.meta(req)));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('login')
  @HttpCode(200)
  @ApiOperation({ summary: 'Sign in with email and password' })
  async login(@Body() dto: LoginDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SessionResponse> {
    return this.writeSession(res, await this.auth.login(dto, this.meta(req)));
  }

  @Public()
  @Throttle(AUTH_THROTTLE)
  @Post('accept-invite')
  @ApiOperation({ summary: 'Accept an organization invitation' })
  async acceptInvite(@Body() dto: AcceptInviteDto, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SessionResponse> {
    return this.writeSession(res, await this.auth.acceptInvite(dto, this.meta(req)));
  }

  @Public()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @Post('refresh')
  @HttpCode(200)
  @ApiOperation({ summary: 'Rotate the refresh token and issue a new access token' })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<SessionResponse> {
    const token = req.cookies?.[COOKIE_REFRESH] as string | undefined;
    const csrfCookie = req.cookies?.[COOKIE_CSRF] as string | undefined;
    const csrfHeader = req.headers[HEADER_CSRF];
    if (!csrfCookie || typeof csrfHeader !== 'string' || !EncryptionService.safeEqual(csrfCookie, csrfHeader)) {
      throw AppException.forbidden('CSRF validation failed', 'CSRF_FAILED');
    }
    if (!token) throw AppException.unauthorized('No session', 'REFRESH_MISSING');
    try {
      return this.writeSession(res, await this.auth.refresh(token, this.meta(req)));
    } catch (err) {
      res.clearCookie(COOKIE_REFRESH, this.cookieBase());
      throw err;
    }
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<void> {
    await this.auth.logout(req.cookies?.[COOKIE_REFRESH] as string | undefined);
    res.clearCookie(COOKIE_REFRESH, this.cookieBase());
    res.clearCookie(COOKIE_CSRF, { ...this.cookieBase(), path: '/' });
  }

  @Get('me')
  @ApiBearerAuth()
  @AllowNoOrganization()
  @ApiOperation({ summary: 'Current user, memberships and effective permissions' })
  async me(@CurrentUser() user: AuthContext | AuthUserOnly): Promise<MeResponse> {
    const memberships = await this.auth.memberships(user.userId);
    return {
      user: { id: user.userId, email: user.email, name: user.name, avatarUrl: null },
      memberships,
      activeOrganizationId: user.organizationId,
      permissions: user.organizationId ? [...(user as AuthContext).permissions] : [],
    };
  }

  @Post('change-password')
  @ApiBearerAuth()
  @AllowNoOrganization()
  @HttpCode(204)
  async changePassword(@CurrentUser() user: AuthContext | AuthUserOnly, @Body() dto: ChangePasswordDto): Promise<void> {
    await this.auth.changePassword(user.userId, dto.currentPassword, dto.newPassword);
  }
}

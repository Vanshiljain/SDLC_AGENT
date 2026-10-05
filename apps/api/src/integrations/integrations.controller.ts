import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsObject, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import type { Response } from 'express';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@forgeline/shared';
import { CurrentAuth, Public, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors';
import { IntegrationsService } from './integrations.service';

function parseProvider(raw: string): IntegrationProvider {
  const p = raw.toUpperCase().replace(/-/g, '_') as IntegrationProvider;
  if (!INTEGRATION_PROVIDERS.includes(p)) throw AppException.badRequest(`Unknown provider "${raw}"`);
  return p;
}

class ConnectTokenDto {
  @ApiProperty({ description: 'Provider-specific credential fields (see GET /integrations/providers)' })
  @IsObject()
  credentials!: Record<string, unknown>;
}
class StartOAuthDto {
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) returnTo?: string;
}
class TrelloCompleteDto {
  @ApiProperty() @IsString() @MaxLength(200) state!: string;
  @ApiProperty() @IsString() @MaxLength(500) token!: string;
}
class EnableWebhookDto {
  @ApiPropertyOptional() @IsOptional() @Matches(/^[\w.-]+\/[\w.-]+$/) repository?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(64) boardId?: string;
}
class RepoListQuery {
  @ApiPropertyOptional() @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;
}

@ApiTags('integrations')
@ApiBearerAuth()
@Controller('integrations')
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get('providers')
  @ApiOperation({ summary: 'Supported providers, capabilities and available auth methods' })
  @RequirePermissions('integration:read')
  providers() {
    return this.integrations.catalog();
  }

  @Get()
  @RequirePermissions('integration:read')
  list(@CurrentAuth() auth: AuthContext) {
    return this.integrations.list(auth.organizationId);
  }

  @Get('github/repositories')
  @ApiOperation({ summary: 'Repositories visible to the connected GitHub account' })
  @RequirePermissions('integration:read')
  githubRepos(@CurrentAuth() auth: AuthContext, @Query() q: RepoListQuery) {
    return this.integrations.listGitHubRepositories(auth.organizationId, q.page ?? 1);
  }

  @Get(':id')
  @RequirePermissions('integration:read')
  get(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.get(auth.organizationId, id);
  }

  @Post(':provider/connect')
  @ApiOperation({ summary: 'Connect with API token / key (verified live before storing, encrypted at rest)' })
  @RequirePermissions('integration:manage')
  connect(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Body() dto: ConnectTokenDto) {
    return this.integrations.connectWithToken(auth, parseProvider(provider), dto.credentials);
  }

  @Post(':provider/oauth/start')
  @ApiOperation({ summary: 'Begin an OAuth authorization (returns the provider authorize URL)' })
  @RequirePermissions('integration:manage')
  startOAuth(@CurrentAuth() auth: AuthContext, @Param('provider') provider: string, @Body() dto: StartOAuthDto) {
    return this.integrations.startOAuth(auth, parseProvider(provider), dto.returnTo);
  }

  @Public()
  @Get('oauth/:provider/callback')
  @ApiOperation({ summary: 'OAuth redirect target (state-validated)' })
  async oauthCallback(@Param('provider') provider: string, @Query('code') code: string, @Query('state') state: string, @Query('error') error: string | undefined, @Res() res: Response) {
    const p = parseProvider(provider);
    if (error || !code || !state) {
      const target = await this.integrations.oauthCallback(p, '', state ?? '').catch(() => null);
      return res.redirect(target ?? `/?error=${encodeURIComponent(error ?? 'oauth_failed')}`);
    }
    return res.redirect(await this.integrations.oauthCallback(p, code, state));
  }

  @Post('trello/complete')
  @ApiOperation({ summary: 'Complete Trello authorization (token from the authorize redirect fragment)' })
  @RequirePermissions('integration:manage')
  completeTrello(@CurrentAuth() auth: AuthContext, @Body() dto: TrelloCompleteDto) {
    return this.integrations.completeTrello(auth, dto.state, dto.token);
  }

  @Post(':id/health')
  @HttpCode(200)
  @RequirePermissions('integration:read')
  health(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.checkHealth(auth.organizationId, id);
  }

  @Post(':id/webhooks')
  @RequirePermissions('integration:manage')
  enableWebhook(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() dto: EnableWebhookDto) {
    return this.integrations.enableWebhook(auth, id, dto);
  }

  @Delete(':id')
  @HttpCode(204)
  @RequirePermissions('integration:manage')
  disconnect(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.integrations.disconnect(auth, id);
  }
}

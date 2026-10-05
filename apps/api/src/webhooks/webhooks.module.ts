import { Controller, Head, HttpCode, Module, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { INTEGRATION_PROVIDERS, type IntegrationProvider } from '@forgeline/shared';
import { Public } from '../common/auth/auth-context';
import { AppException } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { Inject } from '@nestjs/common';
import { WebhooksService } from './webhooks.service';

@ApiExcludeController()
@Controller('webhooks')
export class WebhooksController {
  constructor(
    private readonly webhooks: WebhooksService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Trello validates callback URLs with a HEAD request. */
  @Public()
  @Head(':provider/:webhookId')
  @HttpCode(200)
  head(): void {
    return;
  }

  @Public()
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @Post(':provider/:webhookId')
  @HttpCode(202)
  async receive(@Param('provider') providerRaw: string, @Param('webhookId', ParseUUIDPipe) webhookId: string, @Req() req: Request) {
    const provider = providerRaw.toUpperCase().replace(/-/g, '_') as IntegrationProvider;
    if (!INTEGRATION_PROVIDERS.includes(provider)) throw AppException.notFound('Webhook');
    if (!req.rawBody) throw AppException.badRequest('Raw body required');
    return this.webhooks.handle({
      provider,
      webhookId,
      rawBody: req.rawBody,
      headers: req.headers,
      body: (req.body ?? {}) as Record<string, unknown>,
      url: `${this.config.apiPublicUrl}${req.originalUrl}`,
    });
  }
}

@Module({
  controllers: [WebhooksController],
  providers: [WebhooksService],
})
export class WebhooksModule {}

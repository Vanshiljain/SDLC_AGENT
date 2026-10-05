import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.provider';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { IntegrationsService } from './integrations.service';

/** Periodic health checks of connected integrations (worker role, single runner via Redis lock). */
@Injectable()
export class IntegrationHealthScheduler {
  private readonly logger = new Logger(IntegrationHealthScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly integrations: IntegrationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Cron(CronExpression.EVERY_30_MINUTES)
  async run(): Promise<void> {
    if (this.config.role === 'api') return;
    const lock = await this.redis.client.set('forgeline:lock:integration-health', '1', 'EX', 600, 'NX');
    if (!lock) return;
    const rows = await this.prisma.integration.findMany({ where: { deletedAt: null, status: { in: ['CONNECTED', 'ERROR'] } }, select: { id: true, organizationId: true } });
    for (const row of rows) {
      try {
        await this.integrations.checkHealth(row.organizationId, row.id);
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, integrationId: row.id }, 'Health check failed');
      }
    }
  }
}

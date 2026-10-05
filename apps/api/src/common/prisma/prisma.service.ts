import { Inject, Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@forgeline/database';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super({
      datasources: { db: { url: config.databaseUrl } },
      log: [
        { level: 'warn', emit: 'event' },
        { level: 'error', emit: 'event' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    (this as unknown as { $on: (e: string, cb: (ev: { message: string }) => void) => void }).$on('warn', (e) =>
      this.logger.warn(e.message),
    );
    (this as unknown as { $on: (e: string, cb: (ev: { message: string }) => void) => void }).$on('error', (e) =>
      this.logger.error(e.message),
    );
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}

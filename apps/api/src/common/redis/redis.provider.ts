import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/configuration';

/**
 * Redis connections: a general command connection plus lazily-created
 * dedicated connections for pub/sub subscribers (which cannot issue commands).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly connections: Redis[] = [];
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    this.client = this.create('main');
  }

  create(name: string, options: { maxRetriesPerRequest?: number | null } = {}): Redis {
    const conn = new Redis(this.config.redisUrl, {
      lazyConnect: false,
      maxRetriesPerRequest: options.maxRetriesPerRequest === undefined ? 3 : options.maxRetriesPerRequest,
      enableReadyCheck: true,
      connectionName: `forgeline:${name}`,
      retryStrategy: (times) => Math.min(times * 200, 5_000),
    });
    conn.on('error', (err) => this.logger.warn(`Redis[${name}] ${err.message}`));
    this.connections.push(conn);
    return conn;
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.client.ping()) === 'PONG';
    } catch {
      return false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.connections.map((c) => c.quit().catch(() => c.disconnect())));
  }
}

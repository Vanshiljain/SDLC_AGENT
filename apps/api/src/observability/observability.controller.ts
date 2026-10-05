import { Controller, Get, Headers, Inject, Res } from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Response } from 'express';
import { Public } from '../common/auth/auth-context';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.provider';
import { EncryptionService } from '../common/crypto/encryption.service';
import { AppException } from '../common/errors';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { MetricsService } from './metrics.service';
import { VECTOR_STORE } from '../knowledge/knowledge.tokens';
import type { VectorStore } from '@forgeline/ai';

@ApiTags('health')
@SkipThrottle()
@Controller()
export class ObservabilityController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly metrics: MetricsService,
    @Inject(VECTOR_STORE) private readonly vectors: VectorStore,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Public()
  @Get('health')
  liveness() {
    return { status: 'ok', role: this.config.role, time: new Date().toISOString() };
  }

  @Public()
  @Get('health/ready')
  async readiness(@Res({ passthrough: true }) res: Response) {
    const [db, redis, qdrant] = await Promise.all([
      this.prisma.$queryRaw`SELECT 1`.then(() => ({ ok: true })).catch((e: Error) => ({ ok: false, message: e.message })),
      this.redis.ping().then((ok) => ({ ok })),
      this.vectors.health(),
    ]);
    const ok = db.ok && redis.ok;
    res.status(ok ? 200 : 503);
    return { status: ok ? 'ready' : 'degraded', checks: { database: db, redis, qdrant: { ...qdrant, required: false } } };
  }

  @Public()
  @ApiExcludeEndpoint()
  @Get('metrics')
  async prometheus(@Headers('authorization') authorization: string | undefined, @Res() res: Response) {
    if (!this.config.metrics.enabled) throw AppException.notFound('Endpoint');
    if (this.config.metrics.token && !EncryptionService.safeEqual(authorization ?? '', `Bearer ${this.config.metrics.token}`)) {
      throw AppException.unauthorized();
    }
    res.setHeader('Content-Type', this.metrics.registry.contentType);
    res.send(await this.metrics.registry.metrics());
  }
}

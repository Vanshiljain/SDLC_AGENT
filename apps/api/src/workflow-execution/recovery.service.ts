import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Prisma } from '@forgeline/database';
import { workflowDefinitionSchema } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.provider';
import { JobQueue } from '../queues/job-queue.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { EngineRunner } from './engine-runner.service';

const GRACE_MS = 60_000;

/**
 * Crash recovery. Runs on worker start and every 30s (one instance at a time):
 *  - steps whose worker lease expired (process died) are retried or failed
 *  - queued / scheduled / polling steps whose job was lost are re-dispatched
 *  - runs with no active work are re-advanced
 *  - runs exceeding their definition timeout are failed
 */
@Injectable()
export class RecoveryService implements OnApplicationBootstrap {
  private readonly logger = new Logger(RecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly queue: JobQueue,
    private readonly runner: EngineRunner,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (this.config.role === 'api' || this.config.env === 'test') return;
    setTimeout(() => void this.sweep().catch((err: unknown) => this.logger.error({ err }, 'Initial recovery sweep failed')), 2_000);
  }

  @Interval(30_000)
  async scheduled(): Promise<void> {
    if (this.config.role === 'api' || this.config.env === 'test') return;
    await this.sweep();
  }

  async sweep(): Promise<{ expiredLeases: number; redispatched: number; readvanced: number; timedOut: number }> {
    const lock = await this.redis.client.set('forgeline:lock:recovery', this.runner.workerId, 'PX', 25_000, 'NX');
    if (!lock) return { expiredLeases: 0, redispatched: 0, readvanced: 0, timedOut: 0 };
    const now = Date.now();
    const stats = { expiredLeases: 0, redispatched: 0, readvanced: 0, timedOut: 0 };
    const touched = new Set<string>();

    // 1) Expired leases: the worker executing the step disappeared.
    const expired = await this.prisma.workflowExecutionStep.findMany({ where: { status: 'RUNNING', leaseOwner: { not: null }, leaseExpiresAt: { lt: new Date(now) } }, take: 200 });
    for (const s of expired) {
      const retry = s.attempt < s.maxAttempts;
      const res = await this.prisma.workflowExecutionStep.updateMany({
        where: { id: s.id, status: 'RUNNING', leaseOwner: s.leaseOwner },
        data: retry
          ? { status: 'RETRY_SCHEDULED', attempt: s.attempt + 1, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(now), error: { kind: 'internal', message: `Worker ${s.leaseOwner} lost while executing; retrying`, retryable: true } }
          : { status: 'FAILED', leaseOwner: null, leaseExpiresAt: null, completedAt: new Date(), error: { kind: 'internal', message: 'Worker lost while executing and no attempts remain', retryable: false } },
      });
      if (res.count) {
        stats.expiredLeases++;
        touched.add(s.executionId);
        if (retry) await this.queue.add('step.execute', { stepId: s.id, iteration: s.iteration, attempt: s.attempt + 1, polls: s.polls });
      }
    }

    // 2) Lost jobs: queued, scheduled-retry and polling steps past due.
    const stale = await this.prisma.workflowExecutionStep.findMany({
      where: {
        execution: { status: { in: ['RUNNING', 'WAITING_APPROVAL'] } },
        OR: [
          { status: 'QUEUED', updatedAt: { lt: new Date(now - 2 * GRACE_MS) } },
          { status: 'RETRY_SCHEDULED', nextAttemptAt: { lt: new Date(now - GRACE_MS) } },
          { status: 'RUNNING', leaseOwner: null, nextAttemptAt: { lt: new Date(now - GRACE_MS) } },
        ],
      },
      take: 200,
    });
    for (const s of stale) {
      await this.queue.add('step.execute', { stepId: s.id, iteration: s.iteration, attempt: s.attempt, polls: s.polls });
      await this.prisma.workflowExecutionStep.update({ where: { id: s.id }, data: { updatedAt: new Date() } });
      stats.redispatched++;
    }

    // 3) Runs that may have missed an advance (e.g. crash between step completion and advance).
    const idle = await this.prisma.workflowExecution.findMany({
      where: { status: { in: ['RUNNING', 'WAITING_APPROVAL'] }, updatedAt: { lt: new Date(now - GRACE_MS) } },
      select: { id: true, startedAt: true, definition: true },
      take: 200,
    });
    for (const e of idle) {
      const def = workflowDefinitionSchema.safeParse(e.definition);
      if (def.success && def.data.timeoutMs && e.startedAt && now - e.startedAt.getTime() > def.data.timeoutMs) {
        await this.prisma.workflowExecution.update({ where: { id: e.id }, data: { status: 'FAILED', completedAt: new Date(), error: { message: `Run exceeded its ${Math.round(def.data.timeoutMs / 60_000)} minute timeout` } } });
        await this.prisma.workflowExecutionStep.updateMany({ where: { executionId: e.id, status: { in: ['PENDING', 'QUEUED', 'RETRY_SCHEDULED', 'WAITING_APPROVAL'] } }, data: { status: 'CANCELLED' } });
        stats.timedOut++;
        continue;
      }
      touched.add(e.id);
    }
    for (const id of touched) {
      await this.runner.advance(id).catch((err: unknown) => this.logger.error({ err, executionId: id }, 'Re-advance failed'));
      await this.prisma.workflowExecution.updateMany({ where: { id }, data: { updatedAt: new Date() } }).catch(() => undefined);
      stats.readvanced++;
    }

    // 4) Unfinished compensations.
    const compensating = await this.prisma.workflowExecution.findMany({ where: { status: 'COMPENSATING', updatedAt: { lt: new Date(now - GRACE_MS) } }, select: { id: true }, take: 50 });
    for (const c of compensating) await this.queue.add('run.compensate', { executionId: c.id });

    if (stats.expiredLeases || stats.redispatched || stats.timedOut) this.logger.warn(stats, 'Recovery sweep repaired state');
    return stats;
  }
}

export { Prisma };

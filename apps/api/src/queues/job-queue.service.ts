import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { MetricsService } from '../observability/metrics.service';
import { RequestContext } from '../common/context/request-context';

export type JobName = 'step.execute' | 'run.advance' | 'run.compensate' | 'knowledge.ingest' | 'trigger.fire';

export interface JobOptions {
  /** Deduplicates jobs: a job with the same id is not enqueued twice. */
  jobId?: string;
  delayMs?: number;
}

type Handler = (data: Record<string, unknown>) => Promise<void>;

/**
 * Background job queue. BullMQ (Redis) in production — durable, survives
 * restarts; an inline driver runs jobs in-process for tests and single-process
 * development. Business state never lives only in the queue: every job is
 * re-derivable from Postgres by the recovery sweeper.
 */
export abstract class JobQueue {
  protected readonly handlers = new Map<JobName, Handler>();

  register(name: JobName, handler: Handler): void {
    this.handlers.set(name, handler);
  }

  abstract add(name: JobName, data: Record<string, unknown>, options?: JobOptions): Promise<void>;
  /** Wait until no jobs are pending (inline driver only; used by tests). */
  abstract drain(timeoutMs?: number): Promise<void>;
}

@Injectable()
export class BullJobQueue extends JobQueue implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('JobQueue');
  private readonly queue: Queue;
  private worker?: Worker;

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {
    super();
    this.queue = new Queue(this.config.queueName, {
      connection: { url: config.redisUrl, maxRetriesPerRequest: null },
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2_000 },
        removeOnComplete: { age: 3_600, count: 5_000 },
        removeOnFail: { age: 7 * 86_400 },
      },
    });
  }

  async add(name: JobName, data: Record<string, unknown>, options: JobOptions = {}): Promise<void> {
    await this.queue.add(name, data, { jobId: options.jobId?.replace(/:/g, '_'), delay: options.delayMs && options.delayMs > 0 ? options.delayMs : undefined });
  }

  onApplicationBootstrap(): void {
    if (this.config.role === 'api') return;
    this.worker = new Worker(
      this.config.queueName,
      async (job: Job) => {
        const handler = this.handlers.get(job.name as JobName);
        if (!handler) throw new Error(`No handler registered for job ${job.name}`);
        await RequestContext.run({ requestId: `job:${job.id}` }, () => handler(job.data as Record<string, unknown>));
      },
      {
        connection: { url: this.config.redisUrl, maxRetriesPerRequest: null },
        concurrency: this.config.workerConcurrency,
        lockDuration: 120_000,
        maxStalledCount: 3,
      },
    );
    this.worker.on('completed', (job) => this.metrics.queueJobs.inc({ queue: this.config.queueName, name: job.name, status: 'completed' }));
    this.worker.on('failed', (job, err) => {
      this.metrics.queueJobs.inc({ queue: this.config.queueName, name: job?.name ?? 'unknown', status: 'failed' });
      this.logger.error({ err: err.message, job: job?.name, jobId: job?.id }, 'Job failed');
    });
    this.worker.on('error', (err) => this.logger.error({ err: err.message }, 'Worker error'));
    this.logger.log(`Worker started (concurrency ${this.config.workerConcurrency})`);
  }

  async drain(): Promise<void> {
    /* not applicable for BullMQ */
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

/** In-process driver: deterministic, used by integration tests and QUEUE_DRIVER=inline. */
@Injectable()
export class InlineJobQueue extends JobQueue implements OnModuleDestroy {
  private readonly logger = new Logger('InlineJobQueue');
  private readonly pending = new Set<string>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private running = 0;
  private closed = false;

  async add(name: JobName, data: Record<string, unknown>, options: JobOptions = {}): Promise<void> {
    if (this.closed) return;
    const key = options.jobId ? `${name}:${options.jobId}` : `${name}:${Math.random()}`;
    if (options.jobId && this.pending.has(key)) return;
    this.pending.add(key);
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      void this.run(name, data, key);
    }, Math.max(0, options.delayMs ?? 0));
    this.timers.add(timer);
  }

  private async run(name: JobName, data: Record<string, unknown>, key: string): Promise<void> {
    this.running++;
    this.pending.delete(key);
    try {
      const handler = this.handlers.get(name);
      if (!handler) throw new Error(`No handler for ${name}`);
      await RequestContext.run({ requestId: `inline:${name}` }, () => handler(data));
    } catch (err) {
      this.logger.error({ err: (err as Error).message, name }, 'Inline job failed');
    } finally {
      this.running--;
    }
  }

  async drain(timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pending.size || this.running) {
      if (Date.now() > deadline) throw new Error(`Inline queue did not drain (${this.pending.size} pending, ${this.running} running)`);
      await new Promise((r) => setTimeout(r, 20));
    }
  }

  onModuleDestroy(): void {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
  }
}

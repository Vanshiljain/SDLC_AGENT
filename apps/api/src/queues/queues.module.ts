import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { MetricsService } from '../observability/metrics.service';
import { BullJobQueue, InlineJobQueue, JobQueue } from './job-queue.service';

@Global()
@Module({
  providers: [
    {
      provide: JobQueue,
      inject: [APP_CONFIG, MetricsService],
      useFactory: (c: AppConfig, metrics: MetricsService) => (c.queueDriver === 'inline' ? new InlineJobQueue() : new BullJobQueue(c, metrics)),
    },
  ],
  exports: [JobQueue],
})
export class QueuesModule {}

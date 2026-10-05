import { Global, Module } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import { ObservabilityController } from './observability.controller';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';

@Global()
@Module({
  providers: [MetricsService, HttpMetricsInterceptor],
  controllers: [ObservabilityController],
  exports: [MetricsService, HttpMetricsInterceptor],
})
export class ObservabilityModule {}

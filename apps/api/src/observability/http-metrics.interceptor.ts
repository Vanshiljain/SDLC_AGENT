import { type CallHandler, type ExecutionContext, Injectable, type NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { type Observable, tap } from 'rxjs';
import { MetricsService } from './metrics.service';

@Injectable()
export class HttpMetricsInterceptor implements NestInterceptor {
  constructor(private readonly metrics: MetricsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const started = process.hrtime.bigint();
    const route = (req.route as { path?: string } | undefined)?.path ?? 'unmatched';
    const done = () => {
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      this.metrics.httpDuration.observe({ method: req.method, route }, seconds);
      this.metrics.httpRequests.inc({ method: req.method, route, status: String(res.statusCode) });
    };
    return next.handle().pipe(tap({ next: done, error: done }));
  }
}

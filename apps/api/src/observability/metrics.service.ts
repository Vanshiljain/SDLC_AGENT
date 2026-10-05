import { Injectable } from '@nestjs/common';
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';

/** Prometheus metrics (scraped at /metrics). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();

  readonly httpRequests = new Counter({
    name: 'forgeline_http_requests_total',
    help: 'HTTP requests',
    labelNames: ['method', 'route', 'status'] as const,
    registers: [this.registry],
  });
  readonly httpDuration = new Histogram({
    name: 'forgeline_http_request_duration_seconds',
    help: 'HTTP request duration',
    labelNames: ['method', 'route'] as const,
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [this.registry],
  });
  readonly workflowRuns = new Counter({
    name: 'forgeline_workflow_runs_total',
    help: 'Workflow runs reaching a terminal state',
    labelNames: ['status', 'template', 'mode'] as const,
    registers: [this.registry],
  });
  readonly stepDuration = new Histogram({
    name: 'forgeline_workflow_step_duration_seconds',
    help: 'Workflow step execution duration',
    labelNames: ['tool', 'status'] as const,
    buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 180, 600, 1800],
    registers: [this.registry],
  });
  readonly toolExecutions = new Counter({
    name: 'forgeline_tool_executions_total',
    help: 'Tool executions',
    labelNames: ['tool', 'status', 'error_kind'] as const,
    registers: [this.registry],
  });
  readonly llmTokens = new Counter({
    name: 'forgeline_llm_tokens_total',
    help: 'LLM tokens consumed',
    labelNames: ['model', 'type'] as const,
    registers: [this.registry],
  });
  readonly llmCalls = new Counter({
    name: 'forgeline_llm_calls_total',
    help: 'LLM calls',
    labelNames: ['model', 'agent'] as const,
    registers: [this.registry],
  });
  readonly wsConnections = new Gauge({
    name: 'forgeline_ws_connections',
    help: 'Open realtime connections',
    registers: [this.registry],
  });
  readonly queueJobs = new Counter({
    name: 'forgeline_queue_jobs_total',
    help: 'Background jobs processed',
    labelNames: ['queue', 'name', 'status'] as const,
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry, prefix: 'forgeline_' });
  }

  recordLlmUsage(model: string, agent: string, promptTokens: number, completionTokens: number, calls: number): void {
    this.llmTokens.inc({ model, type: 'prompt' }, promptTokens);
    this.llmTokens.inc({ model, type: 'completion' }, completionTokens);
    this.llmCalls.inc({ model, agent }, calls);
  }
}

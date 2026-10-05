import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { ConfigModule } from './config/config.module';
import { APP_CONFIG, type AppConfig } from './config/configuration';
import { CommonModule } from './common/common.module';
import { RedisService } from './common/redis/redis.provider';
import { RedisThrottlerStorage } from './common/throttler/redis-throttler.storage';
import { RequestContextMiddleware } from './common/context/request-context.middleware';
import { RequestContext } from './common/context/request-context';
import { GlobalExceptionFilter } from './common/errors';
import { JwtAuthGuard, PermissionsGuard } from './common/auth/guards';
import { LOG_REDACT_PATHS } from './common/redaction';
import { RbacModule } from './rbac/rbac.module';
import { AuditModule } from './audit/audit.module';
import { EventsModule } from './events/events.module';
import { ObservabilityModule } from './observability/observability.module';
import { HttpMetricsInterceptor } from './observability/http-metrics.interceptor';
import { AiModule } from './ai/ai.module';
import { AuthModule } from './auth/auth.module';
import { OrganizationsModule } from './organizations/organizations.module';
import { UsersModule } from './users/users.controller';
import { IntegrationsModule } from './integrations/integrations.module';
import { ProjectsModule } from './projects/projects.module';
import { QueuesModule } from './queues/queues.module';
import { ToolsModule } from './tools/tools.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { WorkflowExecutionModule } from './workflow-execution/workflow-execution.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { SdlcModule } from './sdlc/sdlc.module';
import { AgentsModule } from './agents/agents.module';
import { ConversationsModule } from './conversations/conversations.module';
import { CommandsModule } from './commands/commands.module';
import { WebhooksModule } from './webhooks/webhooks.module';
import { NotificationsModule } from './notifications/notifications.module';
import { GraphModule } from './graph/graph.module';
import { DashboardModule } from './dashboard/dashboard.module';

@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRootAsync({
      inject: [APP_CONFIG],
      useFactory: (c: AppConfig) => ({
        pinoHttp: {
          level: c.logLevel,
          genReqId: (req: IncomingMessage) => (req as IncomingMessage & { id?: string }).id ?? randomUUID(),
          redact: { paths: LOG_REDACT_PATHS, censor: '[REDACTED]' },
          mixin: () => {
            const { requestId: _r, ip: _ip, userAgent: _ua, ...ctx } = RequestContext.get();
            return ctx;
          },
          autoLogging: { ignore: (req: IncomingMessage) => /^\/(health|metrics)/.test(req.url ?? '') },
          serializers: {
            req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url?.split('?')[0] }),
            res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
          },
          ...(c.env === 'development' && {
            transport: { target: 'pino-pretty', options: { singleLine: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname' } },
          }),
        },
      }),
    }),
    ScheduleModule.forRoot(),
    JwtModule.register({ global: true }),
    ThrottlerModule.forRootAsync({
      inject: [APP_CONFIG, RedisService],
      useFactory: (c: AppConfig, redis: RedisService) => ({
        throttlers: [{ name: 'default', ttl: c.rateLimit.ttlSeconds * 1000, limit: c.rateLimit.max }],
        storage: new RedisThrottlerStorage(redis.client),
      }),
    }),
    CommonModule,
    RbacModule,
    AuditModule,
    EventsModule,
    ObservabilityModule,
    AiModule,
    AuthModule,
    OrganizationsModule,
    UsersModule,
    IntegrationsModule,
    ProjectsModule,
    QueuesModule,
    ToolsModule,
    ApprovalsModule,
    WorkflowExecutionModule,
    WorkflowsModule,
    KnowledgeModule,
    SdlcModule,
    AgentsModule,
    ConversationsModule,
    CommandsModule,
    WebhooksModule,
    NotificationsModule,
    GraphModule,
    DashboardModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useExisting: HttpMetricsInterceptor },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestContextMiddleware).forRoutes('{*path}');
  }
}

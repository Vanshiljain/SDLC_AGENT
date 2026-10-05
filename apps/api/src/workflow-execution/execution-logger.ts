import type { Prisma } from '@forgeline/database';
import type { LogLevel } from '@forgeline/shared';
import type { ToolLogger } from '@forgeline/integrations';
import type { PrismaService } from '../common/prisma/prisma.service';
import type { EventBus } from '../events/event-bus.service';
import { redact } from '../common/redaction';

/**
 * Persists execution logs (shown in the run timeline) and streams them live.
 * Log writes are best-effort and never fail the step.
 */
export class ExecutionLogger implements ToolLogger {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly ctx: { organizationId: string; executionId: string; stepId?: string | null; projectId?: string | null },
  ) {}

  private write(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    const safe = data ? (redact(data, 0, 4000) as Record<string, unknown>) : undefined;
    const text = redact(message).slice(0, 4000);
    void this.prisma.executionLog
      .create({
        data: {
          executionId: this.ctx.executionId,
          stepId: this.ctx.stepId ?? null,
          level,
          message: text,
          data: safe as Prisma.InputJsonValue | undefined,
        },
      })
      .then((row) =>
        this.events.publish({
          type: 'workflow.log',
          organizationId: this.ctx.organizationId,
          projectId: this.ctx.projectId,
          executionId: this.ctx.executionId,
          data: {
            id: row.id,
            stepId: this.ctx.stepId ?? null,
            level,
            message: text,
            data: safe ?? null,
            createdAt: row.createdAt.toISOString(),
          },
        }),
      )
      .catch(() => undefined);
  }

  debug(message: string, data?: Record<string, unknown>) {
    this.write('DEBUG', message, data);
  }
  info(message: string, data?: Record<string, unknown>) {
    this.write('INFO', message, data);
  }
  warn(message: string, data?: Record<string, unknown>) {
    this.write('WARN', message, data);
  }
  error(message: string, data?: Record<string, unknown>) {
    this.write('ERROR', message, data);
  }
}

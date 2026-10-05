import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CronTime } from 'cron';
import { evaluateCondition, resolveTemplates } from '@forgeline/workflow-engine';
import { triggerConfigSchema, type WorkflowDefinition } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RedisService } from '../common/redis/redis.provider';
import { ExecutionsService } from '../workflow-execution/executions.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

export interface ExternalEvent {
  /** e.g. "jira.issue.transitioned", "github.pull_request.opened" */
  name: string;
  deliveryId: string;
  payload: Record<string, unknown>;
}

/**
 * Event and schedule triggers. Flows run as their creator (permissions are
 * re-checked at every tool call) and are de-duplicated per delivery.
 */
@Injectable()
export class TriggersService {
  private readonly logger = new Logger(TriggersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly executions: ExecutionsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async dispatchEvent(organizationId: string, event: ExternalEvent): Promise<string[]> {
    const triggers = await this.prisma.workflowTrigger.findMany({
      where: { type: 'EVENT', isEnabled: true, workflow: { organizationId, deletedAt: null, status: 'ACTIVE' } },
      include: { workflow: true },
    });
    const started: string[] = [];
    for (const t of triggers) {
      const cfg = triggerConfigSchema.safeParse(t.config);
      if (!cfg.success || cfg.data.type !== 'EVENT' || cfg.data.event !== event.name) continue;
      const scope = { inputs: {}, variables: {}, steps: {}, event: event.payload };
      try {
        if (cfg.data.filter && !evaluateCondition(cfg.data.filter, scope)) continue;
        const inputs = resolveTemplates(cfg.data.inputs, scope);
        if (!t.workflow.createdById) continue;
        const exec = await this.executions.start({
          organizationId,
          projectId: t.workflow.projectId,
          userId: t.workflow.createdById,
          title: `${t.workflow.name} · ${event.name}`,
          definition: t.workflow.definition as unknown as WorkflowDefinition,
          input: { ...inputs, event: event.payload },
          workflowId: t.workflow.id,
          workflowVersion: t.workflow.version,
          triggerSource: 'WEBHOOK',
          idempotencyKey: `trigger:${t.id}:${event.deliveryId}`,
        });
        started.push(exec.id);
        await this.prisma.workflowTrigger.update({ where: { id: t.id }, data: { lastFiredAt: new Date() } });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, triggerId: t.id }, 'Event trigger failed to start a run');
      }
    }
    return started;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async fireSchedules(): Promise<void> {
    if (this.config.role === 'api') return;
    const lock = await this.redis.client.set('forgeline:lock:schedules', '1', 'EX', 55, 'NX');
    if (!lock) return;
    const triggers = await this.prisma.workflowTrigger.findMany({
      where: { type: 'SCHEDULE', isEnabled: true, workflow: { deletedAt: null, status: 'ACTIVE' } },
      include: { workflow: true },
    });
    const now = new Date();
    for (const t of triggers) {
      const cfg = triggerConfigSchema.safeParse(t.config);
      if (!cfg.success || cfg.data.type !== 'SCHEDULE' || !t.workflow.createdById) continue;
      try {
        const from = t.lastFiredAt ?? t.createdAt;
        const next = new CronTime(cfg.data.cron, cfg.data.timezone).getNextDateFrom(from).toJSDate();
        if (next > now) continue;
        const minuteKey = `${now.toISOString().slice(0, 16)}`;
        await this.executions.start({
          organizationId: t.workflow.organizationId,
          projectId: t.workflow.projectId,
          userId: t.workflow.createdById,
          title: `${t.workflow.name} · scheduled`,
          definition: t.workflow.definition as unknown as WorkflowDefinition,
          input: {},
          workflowId: t.workflow.id,
          workflowVersion: t.workflow.version,
          triggerSource: 'SCHEDULE',
          idempotencyKey: `schedule:${t.id}:${minuteKey}`,
        });
        await this.prisma.workflowTrigger.update({ where: { id: t.id }, data: { lastFiredAt: now } });
      } catch (err) {
        this.logger.warn({ err: (err as Error).message, triggerId: t.id }, 'Scheduled trigger failed');
      }
    }
  }
}

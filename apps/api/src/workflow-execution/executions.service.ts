import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@forgeline/database';
import { isUniqueViolation } from '@forgeline/database';
import {
  assertValidWorkflowDefinition,
  stepsToResetForRetry,
  topologicalOrder,
  resolveRetryPolicy,
  repairStepKeys,
} from '@forgeline/workflow-engine';
import type {
  ExecutionMode,
  ExecutionStatus,
  StepStatus,
  TriggerSource,
  WorkflowDefinition,
  WorkflowDefinitionInput,
} from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { EventBus } from '../events/event-bus.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { JobQueue } from '../queues/job-queue.service';
import { AuthorizationService } from '../rbac/authorization.service';
import type { AuthContext } from '../common/auth/auth-context';
import { paginate, skipTake } from '../common/pagination';
import { EngineRunner } from './engine-runner.service';

export interface StartExecutionParams {
  organizationId: string;
  projectId: string | null;
  /** Principal: the run executes with this user's permissions. */
  userId: string;
  title: string;
  definition: WorkflowDefinitionInput | WorkflowDefinition;
  input?: Record<string, unknown>;
  template?: string | null;
  workflowId?: string | null;
  workflowVersion?: number | null;
  conversationId?: string | null;
  triggerSource: TriggerSource;
  idempotencyKey?: string | null;
}

const TERMINAL: ExecutionStatus[] = ['COMPLETED', 'FAILED', 'CANCELLED', 'COMPENSATED'];

/** Validate and coerce run inputs against the definition's input spec. */
export function resolveInputs(definition: WorkflowDefinition, input: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input };
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(definition.inputs)) {
    let v = out[name];
    if ((v === undefined || v === '') && spec.default !== undefined) v = spec.default;
    if (v === undefined || v === null || v === '') {
      if (spec.required) problems.push(`"${name}" is required`);
      continue;
    }
    if (spec.type === 'number' && typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) v = Number(v);
    if (spec.type === 'boolean' && typeof v === 'string') v = ['true', '1', 'yes'].includes(v.toLowerCase());
    const actual = Array.isArray(v) ? 'array' : typeof v;
    if (actual !== spec.type) problems.push(`"${name}" must be ${spec.type}`);
    if (spec.enum && typeof v === 'string' && !spec.enum.includes(v)) problems.push(`"${name}" must be one of ${spec.enum.join(', ')}`);
    out[name] = v;
  }
  if (problems.length) throw AppException.badRequest(`Invalid inputs: ${problems.join('; ')}`, 'INVALID_INPUTS');
  return out;
}

@Injectable()
export class ExecutionsService {
  private readonly logger = new Logger(ExecutionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly registry: ToolRegistry,
    private readonly runner: EngineRunner,
    private readonly approvals: ApprovalsService,
    private readonly queue: JobQueue,
    private readonly authz: AuthorizationService,
  ) {}

  async start(p: StartExecutionParams) {
    const definition = assertValidWorkflowDefinition(p.definition, { toolExists: (t) => this.registry.has(t) });
    const input = resolveInputs(definition, p.input);
    if (p.projectId) await this.authz.assertProjectInOrg(p.organizationId, p.projectId);
    if (!(await this.authz.hasPermission(p.userId, p.organizationId, 'workflow:execute', p.projectId))) {
      throw AppException.forbidden('Missing permission "workflow:execute"', 'PERMISSION_DENIED');
    }
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: p.organizationId }, select: { isDemo: true } });
    // Demo workspaces only ever run simulated tools; real workspaces never do.
    const mode: ExecutionMode = org.isDemo ? 'DEMO' : 'LIVE';

    if (p.idempotencyKey) {
      const existing = await this.prisma.workflowExecution.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: p.organizationId, idempotencyKey: p.idempotencyKey } },
      });
      if (existing) return existing;
    }

    const { order } = topologicalOrder(definition.steps);
    const position = new Map(order.map((k, i) => [k, i]));
    const repairKeys = repairStepKeys(definition.steps);
    let execution;
    try {
      execution = await this.prisma.$transaction(async (tx) => {
        const exec = await tx.workflowExecution.create({
          data: {
            organizationId: p.organizationId,
            projectId: p.projectId,
            workflowId: p.workflowId ?? null,
            workflowVersion: p.workflowVersion ?? null,
            conversationId: p.conversationId ?? null,
            title: p.title.slice(0, 200),
            template: p.template ?? null,
            status: 'RUNNING',
            mode,
            definition: definition as unknown as Prisma.InputJsonValue,
            input: input as Prisma.InputJsonValue,
            context: {},
            triggeredById: p.userId,
            triggerSource: p.triggerSource,
            idempotencyKey: p.idempotencyKey ?? null,
            startedAt: new Date(),
          },
        });
        await tx.workflowExecutionStep.createMany({
          data: definition.steps.map((s) => {
            const tool = s.tool ? this.registry.get(s.tool) : undefined;
            return {
              executionId: exec.id,
              stepKey: s.key,
              name: s.name,
              type: s.type,
              tool: s.tool ?? null,
              agent: s.agent ?? tool?.agent ?? (s.type === 'approval' ? 'human' : null),
              status: 'PENDING' as const,
              maxAttempts: s.type === 'tool' ? resolveRetryPolicy(s.retry, tool?.defaultRetry).maxAttempts : 1,
              position: (position.get(s.key) ?? 0) + (repairKeys.has(s.key) ? 1000 : 0),
            };
          }),
        });
        return exec;
      });
    } catch (err) {
      if (isUniqueViolation(err) && p.idempotencyKey) {
        return this.prisma.workflowExecution.findUniqueOrThrow({
          where: { organizationId_idempotencyKey: { organizationId: p.organizationId, idempotencyKey: p.idempotencyKey } },
        });
      }
      throw err;
    }

    await this.audit.record({
      organizationId: p.organizationId,
      actorId: p.userId,
      action: 'workflow.run_started',
      resourceType: 'execution',
      resourceId: execution.id,
      projectId: p.projectId,
      executionId: execution.id,
      input: { title: p.title, template: p.template, source: p.triggerSource, mode, inputs: input },
    });
    await this.events.publish({
      type: 'workflow.started',
      organizationId: p.organizationId,
      projectId: p.projectId,
      executionId: execution.id,
      data: {
        status: 'RUNNING',
        title: execution.title,
        mode,
        template: p.template ?? null,
        progress: { completed: 0, total: definition.steps.length - repairKeys.size },
        conversationId: p.conversationId ?? null,
      },
    });
    await this.runner.advance(execution.id);
    return this.prisma.workflowExecution.findUniqueOrThrow({ where: { id: execution.id } });
  }

  private async load(auth: AuthContext, id: string) {
    const e = await this.prisma.workflowExecution.findFirst({ where: { id, organizationId: auth.organizationId } });
    if (!e) throw AppException.notFound('Run', id);
    return e;
  }

  async list(
    auth: AuthContext,
    q: { page: number; pageSize: number; status?: ExecutionStatus; projectId?: string; search?: string; template?: string },
  ) {
    const where: Prisma.WorkflowExecutionWhereInput = {
      organizationId: auth.organizationId,
      ...(q.status && { status: q.status }),
      ...(q.projectId && { projectId: q.projectId }),
      ...(q.template && { template: q.template }),
      ...(q.search && { title: { contains: q.search, mode: 'insensitive' } }),
    };
    const [items, total] = await Promise.all([
      this.prisma.workflowExecution.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          title: true,
          status: true,
          mode: true,
          template: true,
          triggerSource: true,
          createdAt: true,
          startedAt: true,
          completedAt: true,
          error: true,
          project: { select: { id: true, name: true, key: true } },
          triggeredBy: { select: { id: true, name: true } },
          steps: {
            select: { stepKey: true, name: true, status: true, agent: true, tool: true, position: true },
            orderBy: { position: 'asc' },
          },
          _count: { select: { approvals: { where: { status: 'PENDING' } } } },
        },
        ...skipTake(q),
      }),
      this.prisma.workflowExecution.count({ where }),
    ]);
    return paginate(items, total, q);
  }

  async get(auth: AuthContext, id: string) {
    const e = await this.prisma.workflowExecution.findFirst({
      where: { id, organizationId: auth.organizationId },
      include: {
        project: { select: { id: true, name: true, key: true } },
        workflow: { select: { id: true, name: true, slug: true } },
        triggeredBy: { select: { id: true, name: true, email: true } },
        steps: { orderBy: { position: 'asc' } },
        approvals: { orderBy: { createdAt: 'desc' }, include: { decidedBy: { select: { id: true, name: true } } } },
        artifacts: {
          orderBy: { createdAt: 'asc' },
          select: { id: true, type: true, title: true, stepId: true, contentType: true, url: true, createdAt: true, version: true },
        },
        externalResources: { orderBy: { createdAt: 'asc' } },
        deployments: { orderBy: { createdAt: 'asc' }, include: { environment: { select: { name: true, type: true } } } },
        codeReviews: { orderBy: { createdAt: 'asc' } },
        qaRuns: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            type: true,
            status: true,
            title: true,
            total: true,
            passed: true,
            failed: true,
            skipped: true,
            durationMs: true,
            simulated: true,
            createdAt: true,
          },
        },
        codeGenerations: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            status: true,
            branch: true,
            files: true,
            commitSha: true,
            prUrl: true,
            prNumber: true,
            iterations: true,
            simulated: true,
            validation: true,
          },
        },
      },
    });
    if (!e) throw AppException.notFound('Run', id);
    const [agentRuns, toolExecutions] = await Promise.all([
      this.prisma.agentRun.findMany({
        where: { executionId: id },
        include: { agent: { select: { key: true, name: true, kind: true } } },
        orderBy: { startedAt: 'asc' },
      }),
      this.prisma.toolExecution.findMany({
        where: { executionId: id },
        orderBy: { startedAt: 'asc' },
        select: {
          id: true,
          stepId: true,
          tool: true,
          status: true,
          attempt: true,
          durationMs: true,
          startedAt: true,
          completedAt: true,
          simulated: true,
          externalUrl: true,
          error: true,
        },
      }),
    ]);
    const tokens = agentRuns.reduce((s, r) => s + r.totalTokens, 0);
    return { ...e, agentRuns, toolExecutions, usage: { totalTokens: tokens, llmCalls: agentRuns.reduce((s, r) => s + r.llmCalls, 0) } };
  }

  async logs(auth: AuthContext, id: string, q: { stepId?: string; after?: Date; limit?: number }) {
    await this.load(auth, id);
    return this.prisma.executionLog.findMany({
      where: { executionId: id, ...(q.stepId && { stepId: q.stepId }), ...(q.after && { createdAt: { gt: q.after } }) },
      orderBy: { createdAt: 'asc' },
      take: Math.min(q.limit ?? 500, 2000),
    });
  }

  async artifact(auth: AuthContext, artifactId: string) {
    const a = await this.prisma.artifact.findFirst({ where: { id: artifactId, organizationId: auth.organizationId } });
    if (!a) throw AppException.notFound('Artifact', artifactId);
    return a;
  }

  async updateArtifact(auth: AuthContext, artifactId: string, content: string) {
    const a = await this.artifact(auth, artifactId);
    const updated = await this.prisma.artifact.update({ where: { id: a.id }, data: { content, version: { increment: 1 } } });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'artifact.edited',
      resourceType: 'artifact',
      resourceId: a.id,
      executionId: a.executionId,
      input: { version: updated.version },
    });
    return updated;
  }

  private async assertCanControl(auth: AuthContext, projectId: string | null) {
    await this.authz.assertPermission(auth, 'workflow:execute', projectId);
  }

  async pause(auth: AuthContext, id: string) {
    const e = await this.load(auth, id);
    await this.assertCanControl(auth, e.projectId);
    const res = await this.prisma.workflowExecution.updateMany({
      where: { id, status: { in: ['RUNNING', 'WAITING_APPROVAL'] } },
      data: { status: 'PAUSED', pausedAt: new Date() },
    });
    if (!res.count) throw AppException.conflict(`Cannot pause a ${e.status.toLowerCase()} run`, 'INVALID_STATE');
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.paused',
      resourceType: 'execution',
      resourceId: id,
      executionId: id,
      projectId: e.projectId,
    });
    await this.events.publish({
      type: 'workflow.paused',
      organizationId: auth.organizationId,
      projectId: e.projectId,
      executionId: id,
      data: { status: 'PAUSED', title: e.title },
    });
    return this.get(auth, id);
  }

  async resume(auth: AuthContext, id: string) {
    const e = await this.load(auth, id);
    await this.assertCanControl(auth, e.projectId);
    const res = await this.prisma.workflowExecution.updateMany({
      where: { id, status: 'PAUSED' },
      data: { status: 'RUNNING', pausedAt: null },
    });
    if (!res.count) throw AppException.conflict(`Cannot resume a ${e.status.toLowerCase()} run`, 'INVALID_STATE');
    // Re-dispatch work that was queued while paused.
    const queued = await this.prisma.workflowExecutionStep.findMany({
      where: { executionId: id, status: { in: ['QUEUED', 'RETRY_SCHEDULED'] } },
    });
    for (const s of queued)
      await this.queue.add('step.execute', { stepId: s.id, iteration: s.iteration, attempt: s.attempt, polls: s.polls });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.resumed',
      resourceType: 'execution',
      resourceId: id,
      executionId: id,
      projectId: e.projectId,
    });
    await this.events.publish({
      type: 'workflow.resumed',
      organizationId: auth.organizationId,
      projectId: e.projectId,
      executionId: id,
      data: { status: 'RUNNING', title: e.title },
    });
    await this.runner.advance(id);
    return this.get(auth, id);
  }

  async cancel(auth: AuthContext, id: string, opts: { rollback?: boolean; reason?: string } = {}) {
    const e = await this.load(auth, id);
    await this.assertCanControl(auth, e.projectId);
    if (TERMINAL.includes(e.status as ExecutionStatus))
      throw AppException.conflict(`Run is already ${e.status.toLowerCase()}`, 'INVALID_STATE');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkflowExecution" WHERE id = ${id}::uuid FOR UPDATE`;
      await tx.workflowExecution.update({
        where: { id },
        data: {
          status: opts.rollback ? 'COMPENSATING' : 'CANCELLED',
          cancelledAt: new Date(),
          completedAt: opts.rollback ? null : new Date(),
          error: { message: opts.reason ?? `Cancelled by ${auth.name}` },
        },
      });
      // Running steps observe cancellation via their heartbeat and abort.
      await tx.workflowExecutionStep.updateMany({
        where: {
          executionId: id,
          status: { in: ['PENDING', 'QUEUED', 'RETRY_SCHEDULED', 'WAITING_APPROVAL', 'REPAIRING'] as StepStatus[] },
        },
        data: { status: 'CANCELLED', completedAt: new Date() },
      });
    });
    await this.approvals.cancelForExecution(id);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.cancelled',
      resourceType: 'execution',
      resourceId: id,
      executionId: id,
      projectId: e.projectId,
      input: opts,
    });
    await this.events.publish({
      type: 'workflow.cancelled',
      organizationId: auth.organizationId,
      projectId: e.projectId,
      executionId: id,
      data: { status: opts.rollback ? 'COMPENSATING' : 'CANCELLED', title: e.title },
    });
    if (opts.rollback) await this.queue.add('run.compensate', { executionId: id });
    return this.get(auth, id);
  }

  async retryStep(auth: AuthContext, id: string, stepId: string) {
    const e = await this.load(auth, id);
    await this.assertCanControl(auth, e.projectId);
    if (!['FAILED', 'RUNNING', 'WAITING_APPROVAL', 'CANCELLED'].includes(e.status))
      throw AppException.conflict(`Cannot retry steps of a ${e.status.toLowerCase()} run`, 'INVALID_STATE');
    const steps = await this.prisma.workflowExecutionStep.findMany({ where: { executionId: id } });
    const target = steps.find((s) => s.id === stepId);
    if (!target) throw AppException.notFound('Step', stepId);
    const runtime = Object.fromEntries(
      steps.map((s) => [s.stepKey, { key: s.stepKey, status: s.status as StepStatus, attempt: s.attempt, iteration: s.iteration }]),
    );
    const reset = stepsToResetForRetry(this.runner.definitionOf(e), runtime, target.stepKey);
    if (!reset.length) throw AppException.conflict('Only failed or cancelled steps can be retried', 'INVALID_STATE');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "WorkflowExecution" WHERE id = ${id}::uuid FOR UPDATE`;
      await tx.workflowExecutionStep.updateMany({
        where: { executionId: id, stepKey: { in: reset } },
        data: {
          status: 'PENDING',
          attempt: 0,
          error: Prisma.DbNull,
          leaseOwner: null,
          leaseExpiresAt: null,
          nextAttemptAt: null,
          completedAt: null,
          checkpoint: Prisma.DbNull,
          polls: 0,
          pollStartedAt: null,
        },
      });
      // A rejected/expired gate must be asked again on retry; approved gates remain valid.
      await tx.approval.deleteMany({
        where: { executionId: id, step: { stepKey: { in: reset } }, status: { in: ['REJECTED', 'EXPIRED', 'CANCELLED'] } },
      });
      await tx.workflowExecution.update({
        where: { id },
        data: { status: 'RUNNING', completedAt: null, cancelledAt: null, error: Prisma.DbNull },
      });
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.step_retried',
      resourceType: 'execution',
      resourceId: id,
      executionId: id,
      projectId: e.projectId,
      input: { step: target.stepKey, reset },
    });
    await this.events.publish({
      type: 'workflow.resumed',
      organizationId: auth.organizationId,
      projectId: e.projectId,
      executionId: id,
      data: { status: 'RUNNING', title: e.title, retriedStep: target.stepKey },
    });
    await this.runner.advance(id);
    return this.get(auth, id);
  }

  async rollback(auth: AuthContext, id: string) {
    const e = await this.load(auth, id);
    await this.assertCanControl(auth, e.projectId);
    if (!['FAILED', 'COMPLETED', 'CANCELLED'].includes(e.status))
      throw AppException.conflict('Only finished runs can be rolled back', 'INVALID_STATE');
    await this.prisma.workflowExecution.update({ where: { id }, data: { status: 'COMPENSATING', completedAt: null } });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.rollback_requested',
      resourceType: 'execution',
      resourceId: id,
      executionId: id,
      projectId: e.projectId,
    });
    await this.events.publish({
      type: 'workflow.status',
      organizationId: auth.organizationId,
      projectId: e.projectId,
      executionId: id,
      data: { status: 'COMPENSATING', title: e.title },
    });
    await this.queue.add('run.compensate', { executionId: id });
    return this.get(auth, id);
  }
}

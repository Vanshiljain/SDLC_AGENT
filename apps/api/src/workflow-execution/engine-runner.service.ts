import { nullableJson } from '../common/prisma/json';
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Prisma, type WorkflowExecution, type WorkflowExecutionStep } from '@forgeline/database';
import {
  buildScope,
  computeBackoffDelay,
  evaluateCondition,
  nextCompensation,
  resolveRetryPolicy,
  resolveTemplates,
  schedule,
  type SchedulerDecision,
  type StepRuntimeState,
  type TemplateScope,
} from '@forgeline/workflow-engine';
import {
  ToolError,
  workflowDefinitionSchema,
  type DomainEvent,
  type ExecutionStatus,
  type StepDefinition,
  type StepStatus,
  type WorkflowDefinition,
} from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { RequestContext } from '../common/context/request-context';
import { EventBus } from '../events/event-bus.service';
import { MetricsService } from '../observability/metrics.service';
import { JobQueue } from '../queues/job-queue.service';
import { ToolExecutor } from '../tools/tool-executor.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ApprovalPolicyService } from '../approvals/approval-policy.service';
import { ApprovalsService, type ApprovalDecidedEvent } from '../approvals/approvals.service';
import { ProjectContextService } from '../projects/projects.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { ExecutionLogger } from './execution-logger';
import { ApprovalContextBuilder } from './approval-context.builder';

const LEASE_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const ACTIVE_STEP: StepStatus[] = ['QUEUED', 'RUNNING', 'RETRY_SCHEDULED', 'REPAIRING'];

export interface StepJob {
  stepId: string;
  iteration: number;
  attempt: number;
  polls: number;
  [key: string]: unknown;
}

interface StepError {
  kind: string;
  message: string;
  retryable?: boolean;
  final?: boolean;
  status?: number;
  details?: unknown;
}

type Tx = Prisma.TransactionClient;

/**
 * Persistent workflow runtime.
 *
 *  advance(runId)     — locks the run row, asks the pure scheduler what to do,
 *                       persists the decisions atomically, then dispatches jobs.
 *  executeStep(job)   — claims a step with a lease (conditional update), runs it
 *                       through the policy gate and ToolExecutor, persists the
 *                       outcome, then advances the run.
 *
 * All state is in Postgres; queue jobs are disposable hints. Duplicate or
 * stale jobs are rejected by the claim, and the recovery sweeper re-derives
 * lost work after crashes.
 */
@Injectable()
export class EngineRunner implements OnModuleInit {
  private readonly logger = new Logger(EngineRunner.name);
  readonly workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
    private readonly queue: JobQueue,
    private readonly tools: ToolExecutor,
    private readonly registry: ToolRegistry,
    private readonly policy: ApprovalPolicyService,
    private readonly approvals: ApprovalsService,
    private readonly projects: ProjectContextService,
    private readonly approvalContext: ApprovalContextBuilder,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onModuleInit(): void {
    this.queue.register('step.execute', (data) => this.executeStep(data as unknown as StepJob));
    this.queue.register('run.advance', (data) => this.advance(String(data.executionId)));
    this.queue.register('run.compensate', (data) => this.compensateNext(String(data.executionId)));
    this.events.on<ApprovalDecidedEvent>('approval.granted', (e) => this.onApprovalDecided(e));
    this.events.on<ApprovalDecidedEvent>('approval.rejected', (e) => this.onApprovalDecided(e));
  }

  // ───────────────────────────── helpers ─────────────────────────────

  definitionOf(execution: Pick<WorkflowExecution, 'definition'>): WorkflowDefinition {
    return workflowDefinitionSchema.parse(execution.definition);
  }

  private toRuntime(step: WorkflowExecutionStep): StepRuntimeState {
    const err = step.error as StepError | null;
    return { key: step.stepKey, status: step.status as StepStatus, attempt: step.attempt, iteration: step.iteration, output: step.output, summary: step.summary, errorKind: err?.kind ?? null, final: err?.final };
  }

  async scopeFor(execution: WorkflowExecution, steps: WorkflowExecutionStep[]): Promise<Omit<TemplateScope, 'steps'>> {
    const project = await this.projects.load(execution.organizationId, execution.projectId);
    const def = this.definitionOf(execution);
    return {
      inputs: (execution.input ?? {}) as Record<string, unknown>,
      variables: def.variables,
      project: project
        ? {
            id: project.id,
            name: project.name,
            key: project.key,
            slug: project.slug,
            repository: project.repository ? { fullName: project.repository.fullName, defaultBranch: project.repository.defaultBranch, url: project.repository.url ?? null } : null,
            environments: project.environments.map((e) => e.name),
          }
        : null,
      execution: { id: execution.id, title: execution.title, mode: execution.mode, url: `${this.config.webAppUrl}/executions/${execution.id}`, stepCount: steps.length },
    };
  }

  private stepEventData(step: WorkflowExecutionStep, extra: Record<string, unknown> = {}) {
    const err = step.error as StepError | null;
    return {
      stepId: step.id,
      stepKey: step.stepKey,
      name: step.name,
      status: step.status,
      attempt: step.attempt,
      iteration: step.iteration,
      tool: step.tool,
      agent: step.agent,
      summary: step.summary,
      error: err ? { message: err.message, kind: err.kind } : null,
      durationMs: step.durationMs,
      ...extra,
    };
  }

  private async publishStep(execution: Pick<WorkflowExecution, 'id' | 'organizationId' | 'projectId'>, type: DomainEvent['type'], step: WorkflowExecutionStep, extra: Record<string, unknown> = {}) {
    await this.events.publish({ type, organizationId: execution.organizationId, projectId: execution.projectId, executionId: execution.id, data: this.stepEventData(step, extra) });
  }

  private enqueueStep(step: Pick<WorkflowExecutionStep, 'id' | 'iteration' | 'attempt' | 'polls'>, delayMs = 0): Promise<void> {
    const job: StepJob = { stepId: step.id, iteration: step.iteration, attempt: step.attempt, polls: step.polls };
    return this.queue.add('step.execute', job, { delayMs });
  }

  // ───────────────────────────── advance ─────────────────────────────

  async advance(executionId: string): Promise<void> {
    const after: (() => Promise<void>)[] = [];
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM "WorkflowExecution" WHERE id = ${executionId}::uuid FOR UPDATE`;
        const execution = await tx.workflowExecution.findUnique({ where: { id: executionId } });
        if (!execution) return;
        if (!['RUNNING', 'WAITING_APPROVAL', 'PENDING'].includes(execution.status)) return;
        const steps = await tx.workflowExecutionStep.findMany({ where: { executionId }, orderBy: { position: 'asc' } });
        const definition = this.definitionOf(execution);
        const runtime: Record<string, StepRuntimeState> = Object.fromEntries(steps.map((s) => [s.stepKey, this.toRuntime(s)]));
        const scope = await this.scopeFor(execution, steps);
        const result = schedule({ definition, executionStatus: execution.status as ExecutionStatus, steps: runtime, scope });
        const byKey = new Map(steps.map((s) => [s.stepKey, s]));
        const context = (execution.context ?? {}) as { repair?: Record<string, unknown> };

        for (const d of result.decisions) {
          await this.applyDecision(tx, execution, byKey, d, context, after);
        }
        if (result.decisions.some((d) => d.type === 'begin_repair')) {
          await tx.workflowExecution.update({ where: { id: executionId }, data: { context: context as Prisma.InputJsonValue } });
        }

        let status: ExecutionStatus = execution.status as ExecutionStatus;
        let error: Prisma.InputJsonValue | undefined;
        switch (result.outcome) {
          case 'running':
            status = 'RUNNING';
            break;
          case 'waiting_approval':
            status = 'WAITING_APPROVAL';
            break;
          case 'completed':
            status = 'COMPLETED';
            break;
          case 'failed':
            status = 'FAILED';
            error = { message: `Failed at ${result.blockingFailures.map((k) => byKey.get(k)?.name ?? k).join(', ')}`, steps: result.blockingFailures };
            break;
          case 'compensate':
            status = 'COMPENSATING';
            error = { message: `Failed at ${result.blockingFailures.join(', ')}; rolling back`, steps: result.blockingFailures };
            after.push(() => this.queue.add('run.compensate', { executionId }));
            break;
          case 'stalled':
            status = 'FAILED';
            error = { message: 'Run stalled: no runnable steps remain (check step dependencies)' };
            break;
          default:
            break;
        }
        const terminal = ['COMPLETED', 'FAILED', 'CANCELLED', 'COMPENSATED'].includes(status);
        if (status !== execution.status || result.decisions.length) {
          await tx.workflowExecution.update({
            where: { id: executionId },
            data: { status, revision: { increment: 1 }, ...(error && { error }), ...(terminal && { completedAt: new Date() }), ...(execution.status === 'PENDING' && { startedAt: new Date() }) },
          });
        }
        if (status !== execution.status || result.decisions.length) {
          after.push(() =>
            this.events.publish({
              type: status === 'COMPLETED' ? 'workflow.completed' : status === 'FAILED' ? 'workflow.failed' : 'workflow.status',
              organizationId: execution.organizationId,
              projectId: execution.projectId,
              executionId,
              data: { status, title: execution.title, progress: result.progress, error: error ?? null, mode: execution.mode, template: execution.template, triggeredById: execution.triggeredById, conversationId: execution.conversationId },
            }).then(() => undefined),
          );
        }
        if (terminal && execution.status !== status) {
          this.metrics.workflowRuns.inc({ status, template: execution.template ?? 'custom', mode: execution.mode });
        }
      },
      { timeout: 30_000, maxWait: 15_000 },
    );
    for (const fn of after) await fn().catch((err: unknown) => this.logger.error({ err, executionId }, 'Post-advance action failed'));
  }

  private async applyDecision(
    tx: Tx,
    execution: WorkflowExecution,
    byKey: Map<string, WorkflowExecutionStep>,
    d: SchedulerDecision,
    context: { repair?: Record<string, unknown> },
    after: (() => Promise<void>)[],
  ): Promise<void> {
    const step = byKey.get(d.key);
    if (!step) return;
    switch (d.type) {
      case 'start': {
        const updated = await tx.workflowExecutionStep.update({
          where: { id: step.id },
          data: { status: 'QUEUED', attempt: Math.max(1, step.attempt), leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: null, error: Prisma.DbNull, output: Prisma.DbNull, checkpoint: Prisma.DbNull, polls: 0, pollStartedAt: null },
        });
        after.push(async () => {
          await this.enqueueStep(updated);
          await this.publishStep(execution, 'workflow.step.queued', updated);
        });
        break;
      }
      case 'skip': {
        const updated = await tx.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'SKIPPED', summary: d.reason, completedAt: new Date() } });
        after.push(() => this.publishStep(execution, 'workflow.step.skipped', updated));
        break;
      }
      case 'begin_repair': {
        const repairStep = byKey.get(d.repairKey);
        if (!repairStep) return;
        context.repair = { ...(context.repair ?? {}), [d.repairKey]: { for: d.key, iteration: d.iteration, error: step.error, output: step.output, summary: step.summary } };
        const owner = await tx.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'REPAIRING' } });
        const repair = await tx.workflowExecutionStep.update({
          where: { id: repairStep.id },
          data: { status: 'QUEUED', attempt: 1, iteration: d.iteration, error: Prisma.DbNull, leaseOwner: null, nextAttemptAt: null, checkpoint: Prisma.DbNull, polls: 0, pollStartedAt: null },
        });
        after.push(async () => {
          await this.enqueueStep(repair);
          await this.publishStep(execution, 'workflow.step.repairing', owner, { repairStep: d.repairKey });
          await this.publishStep(execution, 'workflow.step.queued', repair);
          await new ExecutionLogger(this.prisma, this.events, { organizationId: execution.organizationId, executionId: execution.id, stepId: step.id, projectId: execution.projectId }).warn(
            `${step.name} failed (iteration ${d.iteration + 1}); running ${repairStep.name} to repair`,
          );
        });
        break;
      }
      case 'rerun_after_repair': {
        await tx.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'PENDING', iteration: d.iteration, attempt: 0, leaseOwner: null } });
        break;
      }
      case 'fail_step': {
        const prev = (step.error as StepError | null) ?? { kind: 'internal', message: d.reason };
        const updated = await tx.workflowExecutionStep.update({
          where: { id: step.id },
          data: { status: 'FAILED', error: { ...prev, message: prev.message === d.reason ? d.reason : `${prev.message} — ${d.reason}`, final: true } as Prisma.InputJsonValue, completedAt: new Date() },
        });
        after.push(() => this.publishStep(execution, 'workflow.step.failed', updated));
        break;
      }
    }
  }

  // ───────────────────────────── executeStep ─────────────────────────────

  async executeStep(job: StepJob): Promise<void> {
    const now = new Date();
    const claim = await this.prisma.workflowExecutionStep.updateMany({
      where: { id: job.stepId, status: { in: ['QUEUED', 'RETRY_SCHEDULED', 'RUNNING'] }, leaseOwner: null, iteration: job.iteration, attempt: job.attempt, polls: job.polls },
      data: { status: 'RUNNING', leaseOwner: this.workerId, leaseExpiresAt: new Date(now.getTime() + LEASE_MS) },
    });
    if (claim.count !== 1) return; // stale or duplicate job

    let step = await this.prisma.workflowExecutionStep.findUniqueOrThrow({ where: { id: job.stepId } });
    const execution = await this.prisma.workflowExecution.findUniqueOrThrow({ where: { id: step.executionId } });
    return RequestContext.run({ executionId: execution.id, stepId: step.id, organizationId: execution.organizationId }, async () => {
      if (execution.status === 'PAUSED') {
        await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'QUEUED', leaseOwner: null, leaseExpiresAt: null } });
        return;
      }
      if (!['RUNNING', 'WAITING_APPROVAL'].includes(execution.status)) {
        const updated = await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'CANCELLED', leaseOwner: null, completedAt: new Date() } });
        await this.publishStep(execution, 'workflow.step.failed', updated);
        return;
      }
      if (!step.startedAt || job.polls === 0) {
        step = await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { startedAt: step.startedAt && step.polls > 0 ? step.startedAt : new Date() } });
        if (job.polls === 0) await this.publishStep(execution, 'workflow.step.started', step);
      }
      const definition = this.definitionOf(execution);
      const def = definition.steps.find((s) => s.key === step.stepKey);
      if (!def) {
        await this.failStep(execution, step, { kind: 'internal', message: `Step ${step.stepKey} missing from definition`, final: true });
        return this.advance(execution.id);
      }
      const logger = new ExecutionLogger(this.prisma, this.events, { organizationId: execution.organizationId, executionId: execution.id, stepId: step.id, projectId: execution.projectId });
      try {
        switch (def.type) {
          case 'approval':
            await this.runApprovalStep(execution, step, def, logger);
            break;
          case 'condition':
            await this.runConditionStep(execution, step, def);
            break;
          case 'delay':
            await this.runDelayStep(execution, step, def);
            break;
          default:
            await this.runToolStep(execution, step, def, logger);
        }
      } catch (err) {
        // Infrastructure error inside the runner itself (not a tool failure).
        this.logger.error({ err, stepId: step.id }, 'Step runner error');
        await this.failStep(execution, step, { kind: 'internal', message: (err as Error).message ?? 'Runner error' });
      }
      await this.advance(execution.id);
    });
  }

  private async stepScope(execution: WorkflowExecution, step: WorkflowExecutionStep): Promise<TemplateScope> {
    const steps = await this.prisma.workflowExecutionStep.findMany({ where: { executionId: execution.id } });
    const base = await this.scopeFor(execution, steps);
    const repair = ((execution.context ?? {}) as { repair?: Record<string, Record<string, unknown>> }).repair?.[step.stepKey] ?? null;
    return { ...buildScope(base, Object.fromEntries(steps.map((s) => [s.stepKey, this.toRuntime(s)]))), repair };
  }

  private async runConditionStep(execution: WorkflowExecution, step: WorkflowExecutionStep, def: StepDefinition): Promise<void> {
    const scope = await this.stepScope(execution, step);
    const result = evaluateCondition(def.expression ?? 'false', scope);
    await this.completeStep(execution, step, { result }, `Condition evaluated to ${result}`);
  }

  private async runDelayStep(execution: WorkflowExecution, step: WorkflowExecutionStep, def: StepDefinition): Promise<void> {
    const cp = step.checkpoint as { until?: string } | null;
    const until = cp?.until ? new Date(cp.until) : new Date(Date.now() + (def.delayMs ?? 0));
    if (until.getTime() <= Date.now()) {
      await this.completeStep(execution, step, { waitedUntil: until.toISOString() }, 'Delay elapsed');
      return;
    }
    const updated = await this.prisma.workflowExecutionStep.update({
      where: { id: step.id },
      data: { leaseOwner: null, leaseExpiresAt: null, checkpoint: { until: until.toISOString() }, polls: { increment: 1 }, nextAttemptAt: until, summary: `Waiting until ${until.toISOString()}` },
    });
    await this.enqueueStep(updated, until.getTime() - Date.now());
  }

  private async runApprovalStep(execution: WorkflowExecution, step: WorkflowExecutionStep, def: StepDefinition, logger: ExecutionLogger): Promise<void> {
    const existing = await this.prisma.approval.findUnique({ where: { executionStepId: step.id } });
    if (existing?.status === 'APPROVED') {
      await this.completeStep(execution, step, { approved: true, approvalId: existing.id, comment: existing.decisionComment }, `Approved${existing.decisionComment ? `: ${existing.decisionComment}` : ''}`);
      return;
    }
    if (existing && existing.status !== 'PENDING') {
      await this.failStep(execution, step, { kind: 'cancelled', message: `Approval ${existing.status.toLowerCase()}`, final: true });
      return;
    }
    const scope = await this.stepScope(execution, step);
    const cfg = resolveTemplates(def.approval!, scope);
    const steps = await this.prisma.workflowExecutionStep.findMany({ where: { executionId: execution.id } });
    const action = cfg.action ?? 'workflow.gate';
    const decision = await this.policy.evaluate(execution.organizationId, await this.projects.load(execution.organizationId, execution.projectId), action);
    const ctx = await this.approvalContext.build(execution, steps, { action, userId: execution.triggeredById });
    await this.requestApproval(execution, step, {
      title: cfg.title,
      description: cfg.description ?? null,
      action,
      risk: cfg.risk ?? ctx.risk.level,
      requiredPermission: (cfg.requiredPermission as typeof decision.requiredPermission | undefined) ?? decision.requiredPermission,
      allowSelfApproval: cfg.allowSelfApproval ?? decision.allowSelfApproval,
      context: { ...ctx, ...(cfg.context ?? {}) },
      expiresInMinutes: cfg.expiresInMinutes,
    });
    logger.info(`Waiting for approval: ${cfg.title}`);
  }

  private async requestApproval(
    execution: WorkflowExecution,
    step: WorkflowExecutionStep,
    p: { title: string; description: string | null; action: string; risk: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'; requiredPermission: string; allowSelfApproval: boolean; context: Record<string, unknown>; expiresInMinutes?: number },
  ): Promise<void> {
    const approval = await this.approvals.request({
      organizationId: execution.organizationId,
      projectId: execution.projectId,
      executionId: execution.id,
      executionStepId: step.id,
      title: p.title,
      description: p.description,
      action: p.action,
      riskLevel: p.risk,
      context: p.context,
      requiredPermission: p.requiredPermission as never,
      allowSelfApproval: p.allowSelfApproval,
      requestedById: execution.triggeredById,
      expiresInMinutes: p.expiresInMinutes,
    });
    const updated = await this.prisma.workflowExecutionStep.update({
      where: { id: step.id },
      data: { status: 'WAITING_APPROVAL', leaseOwner: null, leaseExpiresAt: null, summary: `Waiting for approval: ${p.title}`, output: { approvalId: approval.id } },
    });
    await this.publishStep(execution, 'workflow.step.waiting_approval', updated, { approvalId: approval.id });
  }

  private async runToolStep(execution: WorkflowExecution, step: WorkflowExecutionStep, def: StepDefinition, logger: ExecutionLogger): Promise<void> {
    const tool = this.registry.get(def.tool!);
    if (!tool) {
      await this.failStep(execution, step, { kind: 'validation', message: `Unknown tool ${def.tool}`, final: true });
      return;
    }
    // 1) Resolve templated input from upstream outputs.
    const scope = await this.stepScope(execution, step);
    let input: Record<string, unknown>;
    try {
      input = resolveTemplates(def.input, scope);
    } catch (err) {
      await this.failStep(execution, step, { kind: 'validation', message: `Input template error: ${(err as Error).message}`, final: true });
      return;
    }

    if (step.polls === 0) await this.recordInput(step.id, input);

    // 2) Policy gate, evaluated at execution time (cannot be bypassed by editing a flow).
    // A gated action executes with the authority of the approver who authorised it
    // (they must hold the gate's required permission); otherwise as the run's initiator.
    let principal = execution.triggeredById;
    const existingGate = await this.prisma.approval.findUnique({ where: { executionStepId: step.id } });
    if (existingGate?.status === 'APPROVED' && existingGate.decidedById) principal = existingGate.decidedById;
    const action = this.policy.actionFor(tool, input);
    if (action && step.polls === 0) {
      const project = await this.projects.load(execution.organizationId, execution.projectId);
      const environment = typeof input.environment === 'string' ? input.environment : null;
      const decision = await this.policy.evaluate(execution.organizationId, project, action, environment);
      if (decision.required) {
        const approval = await this.prisma.approval.findUnique({ where: { executionStepId: step.id } });
        if (!approval) {
          const steps = await this.prisma.workflowExecutionStep.findMany({ where: { executionId: execution.id } });
          const ctx = await this.approvalContext.build(execution, steps, { action, environment, version: typeof input.version === 'string' ? input.version : null, userId: execution.triggeredById });
          await this.requestApproval(execution, step, {
            title: `${tool.title}${environment ? ` → ${environment}` : ''}`,
            description: `${decision.reason}. ${execution.title}`,
            action,
            risk: ctx.risk.level === 'LOW' ? decision.risk : ctx.risk.level,
            requiredPermission: decision.requiredPermission,
            allowSelfApproval: decision.allowSelfApproval,
            context: { ...ctx, input, tool: tool.name },
          });
          logger.info(`Approval required before ${tool.title}: ${decision.reason}`);
          return;
        }
        if (approval.status === 'PENDING') {
          await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'WAITING_APPROVAL', leaseOwner: null } });
          return;
        }
        if (approval.status !== 'APPROVED') {
          await this.failStep(execution, step, { kind: 'cancelled', message: `Approval ${approval.status.toLowerCase()}${approval.decisionComment ? `: ${approval.decisionComment}` : ''}`, final: true });
          return;
        }
        logger.info(`Approved by gate "${approval.title}"${approval.decidedById && approval.decidedById !== execution.triggeredById ? ' — executing with the approver\'s authority' : ''}`);
      }
    }

    // 3) Execute through the tool executor with lease heartbeats.
    const abort = new AbortController();
    const heartbeat = setInterval(() => {
      void (async () => {
        const [, exec] = await Promise.all([
          this.prisma.workflowExecutionStep.updateMany({ where: { id: step.id, leaseOwner: this.workerId }, data: { leaseExpiresAt: new Date(Date.now() + LEASE_MS) } }),
          this.prisma.workflowExecution.findUnique({ where: { id: execution.id }, select: { status: true } }),
        ]);
        if (exec?.status === 'CANCELLED') abort.abort(new Error('cancelled'));
      })().catch(() => undefined);
    }, HEARTBEAT_MS);
    const started = Date.now();
    try {
      const { result, cached } = await this.tools.execute({
        tool: tool.name,
        input,
        organizationId: execution.organizationId,
        userId: principal,
        projectId: execution.projectId,
        executionId: execution.id,
        stepId: step.id,
        stepKey: step.stepKey,
        idempotencyKey: `${execution.id}:${step.stepKey}:${step.iteration}`,
        mode: execution.mode,
        attempt: step.attempt,
        checkpoint: step.checkpoint ?? undefined,
        signal: abort.signal,
        timeoutMs: def.timeoutMs,
        logger,
        onProgress: (u) => {
          void this.publishStep(execution, 'workflow.step.progress', step, { progress: u });
        },
      });
      if (cached) logger.info('Reused recorded result (idempotent retry)');

      if (result.continuation) {
        const pollStartedAt = step.pollStartedAt ?? new Date(started);
        const maxPoll = tool.maxPollDurationMs ?? 60 * 60_000;
        if (Date.now() - pollStartedAt.getTime() > maxPoll) {
          await this.failStep(execution, step, { kind: 'timeout', message: `${tool.title} did not finish within ${Math.round(maxPoll / 60_000)} minutes` });
          return;
        }
        const nextAt = new Date(Date.now() + result.continuation.pollAfterMs);
        const updated = await this.prisma.workflowExecutionStep.update({
          where: { id: step.id },
          data: {
            status: 'RUNNING',
            leaseOwner: null,
            leaseExpiresAt: null,
            checkpoint: (result.continuation.checkpoint ?? {}) as Prisma.InputJsonValue,
            polls: { increment: 1 },
            pollStartedAt,
            nextAttemptAt: nextAt,
            summary: result.continuation.message ?? result.summary,
            output: nullableJson(result.output),
          },
        });
        await this.publishStep(execution, 'workflow.step.progress', updated, { progress: { message: result.continuation.message ?? result.summary } });
        await this.enqueueStep(updated, result.continuation.pollAfterMs);
        return;
      }

      if (def.successCondition) {
        const ok = evaluateCondition(def.successCondition, { ...scope, output: result.output });
        if (!ok) {
          await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { output: nullableJson(result.output), summary: result.summary } });
          await this.failStep(execution, { ...step, summary: result.summary }, { kind: 'assertion', message: `${result.summary} — success condition not met (${def.successCondition})`, retryable: false }, result.output);
          return;
        }
      }
      await this.completeStep(execution, step, result.output, result.summary, Date.now() - started);
    } catch (err) {
      const e = ToolError.from(err);
      const policy = resolveRetryPolicy(def.retry, tool.defaultRetry);
      const maxAttempts = Math.max(step.maxAttempts, policy.maxAttempts);
      if (e.kind === 'cancelled') {
        const updated = await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'CANCELLED', leaseOwner: null, error: e.toJSON() as unknown as Prisma.InputJsonValue, completedAt: new Date() } });
        await this.publishStep(execution, 'workflow.step.failed', updated);
      } else if (e.retryable && step.attempt < maxAttempts) {
        const delay = computeBackoffDelay(policy, step.attempt, e.retryAfterMs);
        const updated = await this.prisma.workflowExecutionStep.update({
          where: { id: step.id },
          data: { status: 'RETRY_SCHEDULED', attempt: step.attempt + 1, leaseOwner: null, leaseExpiresAt: null, nextAttemptAt: new Date(Date.now() + delay), error: e.toJSON() as unknown as Prisma.InputJsonValue, summary: `Retrying in ${Math.round(delay / 1000)}s: ${e.message}` },
        });
        logger.warn(`Attempt ${step.attempt}/${maxAttempts} failed (${e.kind}): ${e.message}. Retrying in ${Math.round(delay / 1000)}s`);
        await this.publishStep(execution, 'workflow.step.retrying', updated, { delayMs: delay });
        await this.enqueueStep(updated, delay);
      } else {
        logger.error(`${tool.title} failed (${e.kind}): ${e.message}`);
        await this.failStep(execution, step, e.toJSON());
      }
      this.metrics.stepDuration.observe({ tool: tool.name, status: 'failed' }, (Date.now() - started) / 1000);
    } finally {
      clearInterval(heartbeat);
    }
  }

  private async completeStep(execution: WorkflowExecution, step: WorkflowExecutionStep, output: unknown, summary: string, durationMs?: number): Promise<void> {
    const total = durationMs ?? (step.startedAt ? Date.now() - step.startedAt.getTime() : null);
    const updated = await this.prisma.workflowExecutionStep.update({
      where: { id: step.id },
      data: { status: 'COMPLETED', output: nullableJson(output), summary: summary.slice(0, 2000), error: Prisma.DbNull, leaseOwner: null, leaseExpiresAt: null, checkpoint: Prisma.DbNull, completedAt: new Date(), durationMs: total ?? undefined },
    });
    if (step.tool) this.metrics.stepDuration.observe({ tool: step.tool, status: 'completed' }, (total ?? 0) / 1000);
    await this.publishStep(execution, 'workflow.step.completed', updated);
  }

  private async failStep(execution: WorkflowExecution, step: WorkflowExecutionStep, error: StepError | ReturnType<ToolError['toJSON']>, output?: unknown): Promise<void> {
    const updated = await this.prisma.workflowExecutionStep.update({
      where: { id: step.id },
      data: {
        status: 'FAILED',
        error: error as unknown as Prisma.InputJsonValue,
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: new Date(),
        durationMs: step.startedAt ? Date.now() - step.startedAt.getTime() : undefined,
        summary: (step.summary && output !== undefined ? step.summary : error.message).slice(0, 2000),
        ...(output !== undefined && { output: nullableJson(output) }),
      },
    });
    await this.publishStep(execution, 'workflow.step.failed', updated);
  }

  // ───────────────────────────── approvals ─────────────────────────────

  private async onApprovalDecided(event: DomainEvent<ApprovalDecidedEvent>): Promise<void> {
    const { stepId, executionId, approved, reason } = event.data;
    const step = await this.prisma.workflowExecutionStep.findUnique({ where: { id: stepId } });
    const execution = await this.prisma.workflowExecution.findUnique({ where: { id: executionId } });
    if (!step || !execution || step.status !== 'WAITING_APPROVAL') return;
    const def = this.definitionOf(execution).steps.find((s) => s.key === step.stepKey);
    if (!approved) {
      await this.failStep(execution, step, { kind: 'cancelled', message: reason, final: true });
    } else if (def?.type === 'approval') {
      await this.completeStep(execution, step, { approved: true, approvalId: event.data.approvalId, reason }, reason);
    } else {
      // Tool gate approved: re-queue the step; the gate check will now pass.
      const updated = await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'QUEUED', leaseOwner: null, summary: reason } });
      await this.publishStep(execution, 'workflow.step.queued', updated);
      await this.enqueueStep(updated);
    }
    if (execution.status === 'WAITING_APPROVAL') {
      await this.prisma.workflowExecution.updateMany({ where: { id: executionId, status: 'WAITING_APPROVAL' }, data: { status: 'RUNNING' } });
    }
    await this.advance(executionId);
  }

  // ───────────────────────────── compensation ─────────────────────────────

  async compensateNext(executionId: string): Promise<void> {
    const execution = await this.prisma.workflowExecution.findUnique({ where: { id: executionId } });
    if (!execution || execution.status !== 'COMPENSATING') return;
    const steps = await this.prisma.workflowExecutionStep.findMany({ where: { executionId } });
    const definition = this.definitionOf(execution);
    const runtime = Object.fromEntries(steps.map((s) => [s.stepKey, this.toRuntime(s)]));
    const next = nextCompensation(definition, runtime);
    if (!next) {
      await this.prisma.workflowExecution.update({ where: { id: executionId }, data: { status: 'COMPENSATED', completedAt: new Date() } });
      this.metrics.workflowRuns.inc({ status: 'COMPENSATED', template: execution.template ?? 'custom', mode: execution.mode });
      await this.events.publish({ type: 'workflow.status', organizationId: execution.organizationId, projectId: execution.projectId, executionId, data: { status: 'COMPENSATED', title: execution.title, progress: { completed: steps.length, total: steps.length } } });
      return;
    }
    const step = steps.find((s) => s.stepKey === next.key)!;
    const logger = new ExecutionLogger(this.prisma, this.events, { organizationId: execution.organizationId, executionId, stepId: step.id, projectId: execution.projectId });
    try {
      const summary = await this.tools.compensate({
        tool: next.tool!,
        input: step.input ?? {},
        output: step.output,
        organizationId: execution.organizationId,
        userId: execution.triggeredById,
        projectId: execution.projectId,
        executionId,
        stepKey: step.stepKey,
        idempotencyKey: `${executionId}:${step.stepKey}:${step.iteration}:compensate`,
        mode: execution.mode,
        logger,
      });
      const updated = await this.prisma.workflowExecutionStep.update({ where: { id: step.id }, data: { status: 'COMPENSATED', summary: `Rolled back: ${summary}` } });
      logger.info(`Compensated ${step.name}: ${summary}`);
      await this.publishStep(execution, 'workflow.step.completed', updated);
      await this.queue.add('run.compensate', { executionId });
    } catch (err) {
      const e = ToolError.from(err);
      logger.error(`Compensation of ${step.name} failed: ${e.message}`);
      await this.prisma.workflowExecution.update({
        where: { id: executionId },
        data: { status: 'FAILED', completedAt: new Date(), error: { message: `Rollback failed at ${step.name}: ${e.message}. Manual intervention required.`, compensationFailed: step.stepKey } },
      });
      await this.events.publish({ type: 'workflow.failed', organizationId: execution.organizationId, projectId: execution.projectId, executionId, data: { status: 'FAILED', title: execution.title, error: { message: `Rollback failed: ${e.message}` } } });
    }
  }

  /** Record the resolved input for display/debugging when a step starts. */
  async recordInput(stepId: string, input: unknown): Promise<void> {
    await this.prisma.workflowExecutionStep.update({ where: { id: stepId }, data: { input: input as Prisma.InputJsonValue } });
  }

  isActiveStatus(status: string): boolean {
    return ACTIVE_STEP.includes(status as StepStatus);
  }
}


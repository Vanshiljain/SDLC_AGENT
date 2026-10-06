import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@forgeline/database';
import { isUniqueViolation } from '@forgeline/database';
import { BRAND, ToolError, type ExecutionMode, type IntegrationProvider, type Permission } from '@forgeline/shared';
import type { AnySdlcTool, ProjectContext, ToolExecutionContext, ToolExecutionResult, ToolLogger } from '@forgeline/integrations';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { AuditService } from '../audit/audit.service';
import { MetricsService } from '../observability/metrics.service';
import { IntegrationsService } from '../integrations/integrations.service';
import { ConnectionResolver } from '../integrations/connection-resolver.service';
import { ProjectContextService } from '../projects/projects.service';
import { RequestContext } from '../common/context/request-context';
import { redact } from '../common/redaction';
import { ToolRegistry } from './tool-registry.service';

export interface ToolInvocation {
  tool: string;
  input: unknown;
  organizationId: string;
  /** Principal the tool acts on behalf of. Agents never exceed this user's permissions. */
  userId: string | null;
  projectId: string | null;
  executionId?: string | null;
  stepId?: string | null;
  stepKey?: string | null;
  agentRunId?: string | null;
  /** Stable key for the logical action; retries reuse it. */
  idempotencyKey: string;
  mode: ExecutionMode;
  attempt?: number;
  checkpoint?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  logger?: ToolLogger;
  onProgress?: (update: { percent?: number; message?: string }) => void;
}

export interface ToolInvocationResult {
  result: ToolExecutionResult;
  cached: boolean;
  toolExecutionId: string;
  durationMs: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

/**
 * The single gateway through which agents and Flows touch the outside world.
 *
 *   validate input → load project context → re-check the principal's permission
 *   → idempotency ledger → (simulate in demo mode | execute with timeout)
 *   → persist ledger, external resources, artifacts → metrics + audit
 */
@Injectable()
export class ToolExecutor {
  private readonly logger = new Logger(ToolExecutor.name);

  constructor(
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly audit: AuditService,
    private readonly metrics: MetricsService,
    private readonly integrations: IntegrationsService,
    private readonly connections: ConnectionResolver,
    private readonly projects: ProjectContextService,
  ) {}

  async execute(inv: ToolInvocation): Promise<ToolInvocationResult> {
    const tool = this.registry.get(inv.tool);
    if (!tool) throw new ToolError('validation', `Unknown tool "${inv.tool}"`, { retryable: false });

    const parsed = tool.inputSchema.safeParse(inv.input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ');
      throw new ToolError('validation', `Invalid input for ${tool.name}: ${issues}`, {
        retryable: false,
        details: { issues: parsed.error.issues },
      });
    }
    const input = parsed.data;
    const project = await this.projects.load(inv.organizationId, inv.projectId);
    if (inv.projectId && !project) throw new ToolError('not_found', 'Project not found', { retryable: false });

    const logger = inv.logger ?? this.defaultLogger(tool.name);
    const abort = new AbortController();
    const ctx: ToolExecutionContext = {
      organizationId: inv.organizationId,
      userId: inv.userId,
      project,
      executionId: inv.executionId ?? null,
      stepKey: inv.stepKey ?? null,
      idempotencyKey: inv.idempotencyKey,
      mode: inv.mode,
      attempt: inv.attempt ?? 1,
      signal: inv.signal ? AbortSignal.any([inv.signal, abort.signal]) : abort.signal,
      logger,
      clients: this.connections.clientsFor(inv.organizationId, project),
      progress: (u) => inv.onProgress?.(u),
      checkpoint: inv.checkpoint,
    };

    await this.assertPermitted(tool, input, ctx, inv);

    const started = Date.now();
    const ledger = await this.openLedger(tool, inv, input);
    if (ledger.cached) {
      logger.info(`Idempotent replay: returning recorded result of ${tool.name}`);
      return {
        result: { ...ledger.cached, summary: `${ledger.cached.summary} (recorded result)` },
        cached: true,
        toolExecutionId: ledger.id,
        durationMs: 0,
      };
    }

    RequestContext.set({ toolExecutionId: ledger.id });
    try {
      const result = await this.run(tool, input, ctx, inv.timeoutMs ?? tool.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS, abort);
      const durationMs = Date.now() - started;
      await this.persistSuccess(tool, inv, ledger.id, result, durationMs, project);
      this.metrics.toolExecutions.inc({ tool: tool.name, status: result.continuation ? 'polling' : 'succeeded', error_kind: '' });
      return { result, cached: false, toolExecutionId: ledger.id, durationMs };
    } catch (err) {
      const error = ToolError.from(err, tool.provider?.toLowerCase());
      const durationMs = Date.now() - started;
      await this.prisma.toolExecution
        .update({
          where: { id: ledger.id },
          data: { status: 'FAILED', error: error.toJSON() as unknown as Prisma.InputJsonValue, durationMs, completedAt: new Date() },
        })
        .catch((e: unknown) => this.logger.error({ err: e }, 'Failed to update tool ledger'));
      this.metrics.toolExecutions.inc({ tool: tool.name, status: 'failed', error_kind: error.kind });
      if (error.kind === 'auth' && tool.provider) {
        await this.integrations
          .markAuthFailure(inv.organizationId, tool.provider as IntegrationProvider, error.message)
          .catch(() => undefined);
      }
      if (tool.sideEffects) {
        await this.audit.record({
          organizationId: inv.organizationId,
          actorId: inv.userId,
          actorType: 'AGENT',
          actorLabel: `${BRAND.name} agent`,
          action: `tool.${tool.name}`,
          resourceType: 'tool',
          resourceId: ledger.id,
          projectId: inv.projectId,
          executionId: inv.executionId,
          tool: tool.name,
          status: error.kind === 'permission' ? 'DENIED' : 'FAILURE',
          input,
          output: { error: error.message, kind: error.kind },
        });
      }
      throw error;
    }
  }

  /** Saga compensation through the same permission + audit path as execution. */
  async compensate(inv: Omit<ToolInvocation, 'input'> & { input: unknown; output: unknown }): Promise<string> {
    const tool = this.registry.get(inv.tool);
    if (!tool) throw new ToolError('validation', `Unknown compensation tool "${inv.tool}"`, { retryable: false });
    if (!tool.compensate) throw new ToolError('validation', `${tool.title} has no compensation action`, { retryable: false });
    const project = await this.projects.load(inv.organizationId, inv.projectId);
    const ctx: ToolExecutionContext = {
      organizationId: inv.organizationId,
      userId: inv.userId,
      project,
      executionId: inv.executionId ?? null,
      stepKey: inv.stepKey ?? null,
      idempotencyKey: inv.idempotencyKey,
      mode: inv.mode,
      attempt: 1,
      signal: inv.signal ?? new AbortController().signal,
      logger: inv.logger ?? this.defaultLogger(tool.name),
      clients: this.connections.clientsFor(inv.organizationId, project),
      progress: () => undefined,
    };
    const parsed = tool.inputSchema.safeParse(inv.input ?? {});
    const input = parsed.success ? parsed.data : inv.input;
    await this.assertPermitted(tool, input, ctx, { ...inv, input });
    const res = inv.mode === 'DEMO' ? { summary: `[Simulated] ${tool.title} rolled back` } : await tool.compensate(input, inv.output, ctx);
    await this.audit.record({
      organizationId: inv.organizationId,
      actorId: inv.userId,
      actorType: 'AGENT',
      action: `tool.${tool.name}.compensate`,
      resourceType: 'tool',
      projectId: inv.projectId,
      executionId: inv.executionId,
      tool: tool.name,
      output: { summary: res.summary },
    });
    return res.summary;
  }

  private async assertPermitted(tool: AnySdlcTool, input: unknown, ctx: ToolExecutionContext, inv: ToolInvocation): Promise<void> {
    const permission: Permission = typeof tool.permission === 'function' ? tool.permission(input, ctx) : tool.permission;
    if (!inv.userId) throw new ToolError('permission', `${tool.name} requires an acting user`, { retryable: false });
    const principal = await this.authz.resolve(inv.userId, inv.organizationId, inv.projectId);
    if (!principal?.permissions.has(permission)) {
      await this.audit.record({
        organizationId: inv.organizationId,
        actorId: inv.userId,
        actorType: 'AGENT',
        action: `tool.${tool.name}`,
        resourceType: 'tool',
        projectId: inv.projectId,
        executionId: inv.executionId,
        tool: tool.name,
        status: 'DENIED',
        output: { missingPermission: permission },
      });
      throw new ToolError('permission', `You do not have permission "${permission}" required by ${tool.title}`, { retryable: false });
    }
  }

  /**
   * Idempotency ledger. Side-effecting tools reuse one row per idempotency key:
   * a SUCCEEDED row short-circuits re-execution (no duplicate tickets/PRs).
   */
  private async openLedger(tool: AnySdlcTool, inv: ToolInvocation, input: unknown): Promise<{ id: string; cached?: ToolExecutionResult }> {
    const useLedger = tool.sideEffects && inv.mode === 'LIVE';
    const key = useLedger ? `${tool.name}:${inv.idempotencyKey}` : `${tool.name}:${inv.idempotencyKey}#${randomUUID()}`;
    const base = {
      organizationId: inv.organizationId,
      executionId: inv.executionId ?? null,
      stepId: inv.stepId ?? null,
      agentRunId: inv.agentRunId ?? null,
      userId: inv.userId,
      tool: tool.name,
      provider: tool.provider,
      input: redact(input, 0, 8000) as Prisma.InputJsonValue,
      simulated: inv.mode === 'DEMO',
      attempt: inv.attempt ?? 1,
    };
    if (useLedger) {
      const existing = await this.prisma.toolExecution.findUnique({
        where: { organizationId_idempotencyKey: { organizationId: inv.organizationId, idempotencyKey: key } },
      });
      if (existing?.status === 'SUCCEEDED' && existing.output) {
        return { id: existing.id, cached: existing.output as unknown as ToolExecutionResult };
      }
      if (existing) {
        await this.prisma.toolExecution.update({
          where: { id: existing.id },
          data: {
            status: 'RUNNING',
            attempt: { increment: 1 },
            error: undefined,
            startedAt: existing.status === 'FAILED' ? new Date() : existing.startedAt,
          },
        });
        return { id: existing.id };
      }
    }
    try {
      const row = await this.prisma.toolExecution.create({ data: { ...base, idempotencyKey: key, status: 'RUNNING' } });
      return { id: row.id };
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new ToolError('conflict', `${tool.name} is already executing for this step`, { retryable: true, retryAfterMs: 5_000 });
      }
      throw err;
    }
  }

  private async run(
    tool: AnySdlcTool,
    input: unknown,
    ctx: ToolExecutionContext,
    timeoutMs: number,
    abort: AbortController,
  ): Promise<ToolExecutionResult> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        abort.abort(new Error('timeout'));
        reject(new ToolError('timeout', `${tool.title} exceeded its ${Math.round(timeoutMs / 1000)}s timeout`));
      }, timeoutMs);
    });
    const cancelled = new Promise<never>((_, reject) => {
      if (ctx.signal.aborted) reject(new ToolError('cancelled', 'Cancelled', { retryable: false }));
      ctx.signal.addEventListener('abort', () => reject(new ToolError('cancelled', 'Cancelled', { retryable: false })), { once: true });
    });
    try {
      let work: Promise<ToolExecutionResult>;
      if (ctx.mode === 'DEMO') {
        if (!tool.simulate) {
          throw new ToolError('not_configured', `${tool.title} has no demo simulation; it is only available with real integrations`, {
            retryable: false,
          });
        }
        work = tool.simulate(input, ctx).then((r) => ({ ...r, simulated: true }));
      } else {
        work = tool.execute(input, ctx);
      }
      const result = await Promise.race([work, timeout, cancelled]);
      if (!result || typeof result.summary !== 'string') {
        throw new ToolError('malformed_response', `${tool.name} returned an invalid result`, { retryable: false });
      }
      return result;
    } finally {
      clearTimeout(timer);
    }
  }

  private async persistSuccess(
    tool: AnySdlcTool,
    inv: ToolInvocation,
    ledgerId: string,
    result: ToolExecutionResult,
    durationMs: number,
    project: ProjectContext | null,
  ): Promise<void> {
    const primary = result.externalResources?.[0];
    const done = !result.continuation;
    await this.prisma.toolExecution.update({
      where: { id: ledgerId },
      data: {
        status: done ? 'SUCCEEDED' : 'RUNNING',
        output: redact(result, 0, 50_000) as unknown as Prisma.InputJsonValue,
        externalResourceId: primary?.externalId,
        externalUrl: primary?.url,
        durationMs,
        completedAt: done ? new Date() : null,
        simulated: Boolean(result.simulated),
      },
    });

    const resourceIds = new Map<string, string>();
    for (const r of result.externalResources ?? []) {
      const parentId = r.parentExternalId ? resourceIds.get(r.parentExternalId) : undefined;
      const row = await this.prisma.externalResource.upsert({
        where: {
          organizationId_provider_type_externalId: {
            organizationId: inv.organizationId,
            provider: r.provider,
            type: r.type,
            externalId: r.externalId,
          },
        },
        create: {
          organizationId: inv.organizationId,
          projectId: project?.id ?? null,
          executionId: inv.executionId ?? null,
          stepKey: inv.stepKey ?? null,
          provider: r.provider,
          type: r.type,
          externalId: r.externalId,
          key: r.key,
          title: r.title,
          url: r.url,
          status: r.status,
          simulated: Boolean(result.simulated),
          data: (r.data ?? {}) as Prisma.InputJsonValue,
          parentId,
        },
        update: {
          key: r.key,
          title: r.title,
          url: r.url,
          status: r.status,
          ...(inv.executionId && { executionId: inv.executionId, stepKey: inv.stepKey }),
        },
      });
      resourceIds.set(r.externalId, row.id);
    }

    if (done && inv.executionId && result.artifacts?.length) {
      await this.prisma.artifact.createMany({
        data: result.artifacts.map((a) => ({
          organizationId: inv.organizationId,
          projectId: project?.id ?? null,
          executionId: inv.executionId!,
          stepId: inv.stepId ?? null,
          type: a.type,
          title: a.title,
          content: a.content,
          contentType: a.contentType ?? 'text/markdown',
          data: (a.data ?? undefined) as Prisma.InputJsonValue | undefined,
          url: a.url,
          createdById: inv.userId,
        })),
      });
    }

    if (tool.sideEffects && done) {
      await this.audit.record({
        organizationId: inv.organizationId,
        actorId: inv.userId,
        actorType: 'AGENT',
        actorLabel: `${BRAND.name} agent`,
        action: `tool.${tool.name}`,
        resourceType: primary?.type?.toLowerCase() ?? 'tool',
        resourceId: primary?.key ?? primary?.externalId ?? ledgerId,
        projectId: inv.projectId,
        executionId: inv.executionId,
        tool: tool.name,
        status: 'SUCCESS',
        input: inv.input,
        output: { summary: result.summary, simulated: Boolean(result.simulated), url: primary?.url },
      });
    }
  }

  private defaultLogger(tool: string): ToolLogger {
    const l = this.logger;
    return {
      debug: (m, d) => l.debug({ tool, ...d }, m),
      info: (m, d) => l.log({ tool, ...d }, m),
      warn: (m, d) => l.warn({ tool, ...d }, m),
      error: (m, d) => l.error({ tool, ...d }, m),
    };
  }
}

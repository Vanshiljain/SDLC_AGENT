import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@forgeline/database';
import {
  generatedWorkflowSchema,
  invokeStructured,
  renderPrompt,
  TEMPLATE_SYNTAX_HELP,
  UsageTracker,
  type GeneratedWorkflow,
  type LlmProvider,
} from '@forgeline/ai';
import {
  triggerConfigSchema,
  type TriggerConfig,
  type TriggerSource,
  type WorkflowDefinition,
  type WorkflowDefinitionInput,
} from '@forgeline/shared';
import { assertValidWorkflowDefinition, layers, topologicalOrder, validateWorkflowDefinition } from '@forgeline/workflow-engine';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ExecutionsService } from '../workflow-execution/executions.service';
import { AgentRunsService } from '../ai/agent-runs.service';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';
import { slugify } from '../organizations/organizations.service';
import type { AuthContext } from '../common/auth/auth-context';
import { FLOW_TEMPLATES, findTemplate } from './flow-templates';

export interface SaveWorkflowInput {
  name: string;
  description?: string;
  projectId?: string | null;
  category?: string;
  definition: WorkflowDefinitionInput;
  isTemplate?: boolean;
}

@Injectable()
export class WorkflowsService {
  private readonly logger = new Logger(WorkflowsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly registry: ToolRegistry,
    private readonly executions: ExecutionsService,
    private readonly agentRuns: AgentRunsService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  validate(definition: unknown) {
    return validateWorkflowDefinition(definition, { toolExists: (t) => this.registry.has(t) });
  }

  private assertValid(definition: unknown): WorkflowDefinition {
    return assertValidWorkflowDefinition(definition, { toolExists: (t) => this.registry.has(t) });
  }

  /** Auto-layout positions for steps that have none (visual builder / run graph). */
  withLayout(definition: WorkflowDefinition): WorkflowDefinition {
    const depth = layers(definition.steps);
    // Repair steps usually have no dependencies of their own (they only run when
    // their target fails), so place them just after the step they repair rather
    // than in the root column.
    for (const s of definition.steps) {
      const repairKey = s.repair?.step;
      const repair = repairKey ? definition.steps.find((r) => r.key === repairKey) : undefined;
      if (repair && repair.dependsOn.length === 0) depth.set(repair.key, Math.max(depth.get(repair.key) ?? 0, (depth.get(s.key) ?? 0) + 1));
    }
    const perLayer = new Map<number, number>();
    return {
      ...definition,
      steps: definition.steps.map((s) => {
        if (s.ui) return s;
        const d = depth.get(s.key) ?? 0;
        const idx = perLayer.get(d) ?? 0;
        perLayer.set(d, idx + 1);
        return { ...s, ui: { x: d * 280, y: idx * 130 } };
      }),
    };
  }

  templates() {
    return FLOW_TEMPLATES.map((t) => {
      const def = this.assertValid(t.definition);
      return {
        key: t.key,
        name: t.name,
        description: t.description,
        category: t.category,
        icon: t.icon,
        stepCount: def.steps.length,
        inputs: def.inputs,
        tools: [...new Set(def.steps.map((s) => s.tool).filter(Boolean))],
        providers: [...new Set(def.steps.map((s) => (s.tool ? this.registry.get(s.tool)?.provider : null)).filter(Boolean))],
        definition: this.withLayout(def),
      };
    });
  }

  templateDefinition(key: string): WorkflowDefinition {
    const t = findTemplate(key);
    if (!t) throw AppException.notFound('Flow template', key);
    return this.assertValid(t.definition);
  }

  list(auth: AuthContext, projectId?: string) {
    return this.prisma.workflow.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null, ...(projectId && { projectId }) },
      include: { project: { select: { id: true, name: true, key: true } }, triggers: true, _count: { select: { executions: true } } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async get(auth: AuthContext, id: string) {
    const wf = await this.prisma.workflow.findFirst({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      include: { project: { select: { id: true, name: true, key: true } }, triggers: true, steps: { orderBy: { position: 'asc' } } },
    });
    if (!wf) throw AppException.notFound('Flow', id);
    const recentRuns = await this.prisma.workflowExecution.findMany({
      where: { workflowId: id },
      orderBy: { createdAt: 'desc' },
      take: 10,
      select: { id: true, title: true, status: true, createdAt: true, completedAt: true, mode: true },
    });
    return { ...wf, recentRuns };
  }

  private async syncSteps(tx: Prisma.TransactionClient, workflowId: string, def: WorkflowDefinition) {
    const { order } = topologicalOrder(def.steps);
    await tx.workflowStep.deleteMany({ where: { workflowId } });
    await tx.workflowStep.createMany({
      data: def.steps.map((s) => ({
        workflowId,
        key: s.key,
        name: s.name,
        type: s.type,
        tool: s.tool ?? null,
        dependsOn: s.dependsOn,
        position: order.indexOf(s.key),
        config: { when: s.when ?? null, runIf: s.runIf, retry: s.retry ?? null } as Prisma.InputJsonValue,
      })),
    });
  }

  async create(auth: AuthContext, input: SaveWorkflowInput) {
    const def = this.withLayout(this.assertValid(input.definition));
    if (input.projectId) await this.assertProject(auth, input.projectId);
    let slug = slugify(input.name);
    if (await this.prisma.workflow.findFirst({ where: { organizationId: auth.organizationId, slug } }))
      slug = `${slug}-${Date.now().toString(36)}`;
    const wf = await this.prisma.$transaction(async (tx) => {
      const created = await tx.workflow.create({
        data: {
          organizationId: auth.organizationId,
          projectId: input.projectId ?? null,
          slug,
          name: input.name,
          description: input.description,
          category: input.category ?? 'custom',
          definition: def as unknown as Prisma.InputJsonValue,
          isTemplate: input.isTemplate ?? false,
          createdById: auth.userId,
        },
      });
      await this.syncSteps(tx, created.id, def);
      return created;
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.created',
      resourceType: 'workflow',
      resourceId: wf.id,
      projectId: wf.projectId,
      input: { name: wf.name, steps: def.steps.length },
    });
    return wf;
  }

  async update(auth: AuthContext, id: string, input: Partial<SaveWorkflowInput>) {
    const existing = await this.prisma.workflow.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
    if (!existing) throw AppException.notFound('Flow', id);
    if (existing.isBuiltIn) throw AppException.forbidden('Built-in flows are read-only; duplicate it to customise', 'READ_ONLY');
    const def = input.definition ? this.withLayout(this.assertValid(input.definition)) : undefined;
    if (input.projectId) await this.assertProject(auth, input.projectId);
    const wf = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.workflow.update({
        where: { id },
        data: {
          ...(input.name && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.projectId !== undefined && { projectId: input.projectId }),
          ...(input.category && { category: input.category }),
          ...(input.isTemplate !== undefined && { isTemplate: input.isTemplate }),
          ...(def && { definition: def as unknown as Prisma.InputJsonValue, version: { increment: 1 } }),
        },
      });
      if (def) await this.syncSteps(tx, id, def);
      return updated;
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.updated',
      resourceType: 'workflow',
      resourceId: id,
      projectId: wf.projectId,
      input: { version: wf.version, definitionChanged: Boolean(def) },
    });
    return wf;
  }

  async setStatus(auth: AuthContext, id: string, status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED') {
    const res = await this.prisma.workflow.updateMany({
      where: { id, organizationId: auth.organizationId, deletedAt: null },
      data: { status },
    });
    if (!res.count) throw AppException.notFound('Flow', id);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: `workflow.${status.toLowerCase()}`,
      resourceType: 'workflow',
      resourceId: id,
    });
    return this.get(auth, id);
  }

  async remove(auth: AuthContext, id: string) {
    const res = await this.prisma.workflow.updateMany({
      where: { id, organizationId: auth.organizationId, deletedAt: null, isBuiltIn: false },
      data: { deletedAt: new Date(), status: 'ARCHIVED' },
    });
    if (!res.count) throw AppException.notFound('Flow', id);
    await this.prisma.workflowTrigger.updateMany({ where: { workflowId: id }, data: { isEnabled: false } });
    await this.audit.record({ organizationId: auth.organizationId, action: 'workflow.deleted', resourceType: 'workflow', resourceId: id });
  }

  async fromTemplate(auth: AuthContext, key: string, params: { name?: string; projectId?: string | null }) {
    const t = findTemplate(key);
    if (!t) throw AppException.notFound('Flow template', key);
    return this.create(auth, {
      name: params.name ?? t.name,
      description: t.description,
      projectId: params.projectId ?? null,
      category: t.category,
      definition: t.definition,
    });
  }

  async run(
    auth: AuthContext,
    id: string,
    params: { projectId?: string | null; input?: Record<string, unknown>; source?: TriggerSource; idempotencyKey?: string },
  ) {
    const wf = await this.prisma.workflow.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
    if (!wf) throw AppException.notFound('Flow', id);
    if (wf.status === 'ARCHIVED') throw AppException.badRequest('Archived flows cannot be run', 'FLOW_ARCHIVED');
    const projectId = params.projectId ?? wf.projectId;
    return this.executions.start({
      organizationId: auth.organizationId,
      projectId,
      userId: auth.userId,
      title: wf.name,
      definition: wf.definition as unknown as WorkflowDefinition,
      input: params.input,
      workflowId: wf.id,
      workflowVersion: wf.version,
      triggerSource: params.source ?? 'MANUAL',
      idempotencyKey: params.idempotencyKey,
    });
  }

  async setTrigger(auth: AuthContext, workflowId: string, config: unknown, enabled = true) {
    const wf = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId: auth.organizationId, deletedAt: null } });
    if (!wf) throw AppException.notFound('Flow', workflowId);
    const parsed = triggerConfigSchema.safeParse(config);
    if (!parsed.success) throw AppException.badRequest(parsed.error.issues.map((i) => i.message).join('; '), 'INVALID_TRIGGER');
    if (parsed.data.type === 'SCHEDULE') {
      const { CronTime } = await import('cron');
      try {
        new CronTime(parsed.data.cron, parsed.data.timezone);
      } catch (err) {
        throw AppException.badRequest(`Invalid cron expression: ${(err as Error).message}`, 'INVALID_TRIGGER');
      }
    }
    const trigger = await this.prisma.workflowTrigger.create({
      data: { workflowId, type: parsed.data.type, config: parsed.data as unknown as Prisma.InputJsonValue, isEnabled: enabled },
    });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.trigger_created',
      resourceType: 'workflow',
      resourceId: workflowId,
      input: parsed.data,
    });
    return trigger;
  }

  async removeTrigger(auth: AuthContext, workflowId: string, triggerId: string) {
    const wf = await this.prisma.workflow.findFirst({ where: { id: workflowId, organizationId: auth.organizationId } });
    if (!wf) throw AppException.notFound('Flow', workflowId);
    await this.prisma.workflowTrigger.deleteMany({ where: { id: triggerId, workflowId } });
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'workflow.trigger_deleted',
      resourceType: 'workflow',
      resourceId: workflowId,
      input: { triggerId },
    });
  }

  /** "Describe workflow": natural language → validated Flow definition + trigger (not saved). */
  async generate(
    auth: AuthContext,
    description: string,
    projectId?: string | null,
  ): Promise<{
    name: string;
    description: string;
    trigger: TriggerConfig;
    definition: WorkflowDefinition | null;
    issues: { path: string; message: string }[];
    raw: GeneratedWorkflow;
  }> {
    const usage = new UsageTracker();
    const run = await this.agentRuns.start({
      organizationId: auth.organizationId,
      agentKey: 'planning',
      task: 'Generate flow from description',
      userId: auth.userId,
      input: { description },
    });
    try {
      const messages = await renderPrompt('workflowGenerate', {
        tools: this.registry.promptCatalog(),
        templateSyntax: TEMPLATE_SYNTAX_HELP,
        description,
      });
      const raw = await invokeStructured({
        model: this.llm.chatModel('planner'),
        schema: generatedWorkflowSchema,
        name: 'generated_workflow',
        messages,
        usage,
        modelName: this.llm.modelName('planner'),
      });
      const candidate = this.toDefinition(raw);
      const result = this.validate(candidate);
      const trigger: TriggerConfig =
        raw.trigger.type === 'EVENT' && raw.trigger.event
          ? { type: 'EVENT', event: raw.trigger.event, filter: raw.trigger.filter ?? undefined, inputs: {} }
          : raw.trigger.type === 'SCHEDULE' && raw.trigger.cron
            ? { type: 'SCHEDULE', cron: raw.trigger.cron, timezone: 'UTC' }
            : { type: 'MANUAL' };
      await this.agentRuns.complete(auth.organizationId, run, {
        usage,
        output: { valid: result.valid, steps: raw.steps.length },
        summary: `Generated "${raw.name}" with ${raw.steps.length} steps${result.valid ? '' : ` (${result.issues.length} issues)`}`,
      });
      return {
        name: raw.name,
        description: raw.description,
        trigger,
        definition: result.definition ? this.withLayout(result.definition) : null,
        issues: result.issues.map((i) => ({ path: i.path, message: i.message })),
        raw,
      };
    } catch (err) {
      await this.agentRuns.fail(auth.organizationId, run, err, usage);
      throw err;
    } finally {
      if (projectId) this.logger.debug({ projectId }, 'Generated flow for project');
    }
  }

  private toDefinition(raw: GeneratedWorkflow): WorkflowDefinitionInput {
    const keys = new Set<string>();
    const norm = (k: string) => {
      let key =
        k
          .toLowerCase()
          .replace(/[^a-z0-9_]+/g, '_')
          .replace(/^[^a-z]+/, '')
          .slice(0, 60) || 'step';
      while (keys.has(key)) key = `${key}_x`;
      keys.add(key);
      return key;
    };
    const keyMap = new Map(raw.steps.map((s) => [s.key, norm(s.key)]));
    return {
      steps: raw.steps.map((s) => {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(s.inputJson || '{}') as unknown;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) input = parsed as Record<string, unknown>;
        } catch {
          input = {};
        }
        return {
          key: keyMap.get(s.key)!,
          name: s.name,
          type: s.type,
          ...(s.type === 'tool' && s.tool ? { tool: s.tool } : {}),
          ...(s.type === 'approval' ? { approval: { title: s.approvalTitle ?? s.name } } : {}),
          ...(s.type === 'condition' ? { expression: s.when ?? 'true' } : {}),
          ...(s.type === 'delay' ? { delayMs: 60_000 } : {}),
          input,
          dependsOn: s.dependsOn.map((d) => keyMap.get(d) ?? d),
          ...(s.when && s.type !== 'condition' ? { when: s.when } : {}),
        };
      }),
    };
  }

  private async assertProject(auth: AuthContext, projectId: string) {
    const p = await this.prisma.project.findFirst({ where: { id: projectId, organizationId: auth.organizationId, deletedAt: null } });
    if (!p) throw AppException.notFound('Project', projectId);
  }
}

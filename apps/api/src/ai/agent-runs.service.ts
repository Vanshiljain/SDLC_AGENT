import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@forgeline/database';
import type { AgentKind } from '@forgeline/shared';
import type { UsageTracker } from '@forgeline/ai';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventBus } from '../events/event-bus.service';
import { MetricsService } from '../observability/metrics.service';
import { RequestContext } from '../common/context/request-context';
import { redact } from '../common/redaction';

export interface SystemAgentDefinition {
  key: string;
  name: string;
  kind: AgentKind;
  description: string;
  modelRole: string;
  tools: string[];
}

/** Built-in agent personas shown across the product (Agents page, run visualisation). */
export const SYSTEM_AGENTS: SystemAgentDefinition[] = [
  { key: 'orchestrator', name: 'Forge · Orchestrator', kind: 'ORCHESTRATOR', description: 'Understands requests, gathers context and proposes Flows.', modelRole: 'orchestrator', tools: ['search_knowledge', 'list_projects', 'propose_flow'] },
  { key: 'planning', name: 'Planning Agent', kind: 'PLANNER', description: 'Turns requirements into tickets, specs and executable plans.', modelRole: 'planner', tools: ['ai.draftTicket', 'ai.generateSpec', 'ai.generatePlan'] },
  { key: 'architect', name: 'Architecture Agent', kind: 'ARCHITECT', description: 'Analyses repositories and grounds designs in the existing architecture.', modelRole: 'planner', tools: ['github.analyzeRepository', 'knowledge.retrieve'] },
  { key: 'code', name: 'Code Agent', kind: 'CODER', description: 'Generates, validates and repairs code changes; commits and opens PRs.', modelRole: 'coder', tools: ['code.generate', 'code.validate', 'code.fix', 'code.commit'] },
  { key: 'review', name: 'Review Agent', kind: 'REVIEWER', description: 'Reviews diffs for correctness, security, performance and tests.', modelRole: 'reviewer', tools: ['code.review', 'code.publishReview'] },
  { key: 'qa', name: 'QA Agent', kind: 'QA', description: 'Derives test cases, runs suites, analyses failures and reports honestly.', modelRole: 'coder', tools: ['qa.run', 'qa.analyzeFailures'] },
  { key: 'docs', name: 'Docs Agent', kind: 'DOCS', description: 'Writes and publishes documentation to Notion.', modelRole: 'planner', tools: ['docs.generate', 'notion.createPage'] },
  { key: 'release', name: 'Release Agent', kind: 'RELEASE', description: 'Runs pipelines, deploys with verification and rolls back on failure.', modelRole: 'fast', tools: ['devops.runPipeline', 'deploy.environment', 'deploy.verify', 'deploy.rollback'] },
];

export interface AgentRunHandle {
  id: string;
  agentKey: string;
  startedAt: number;
}

@Injectable()
export class AgentRunsService implements OnModuleInit {
  private readonly logger = new Logger(AgentRunsService.name);
  private readonly agentIds = new Map<string, string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.syncSystemAgents();
  }

  /** Upsert built-in agents (organizationId = null). */
  async syncSystemAgents(): Promise<void> {
    for (const a of SYSTEM_AGENTS) {
      const existing = await this.prisma.agent.findFirst({ where: { organizationId: null, key: a.key } });
      const data = { name: a.name, kind: a.kind, description: a.description, modelRole: a.modelRole, tools: a.tools };
      const row = existing ? await this.prisma.agent.update({ where: { id: existing.id }, data }) : await this.prisma.agent.create({ data: { ...data, key: a.key } });
      this.agentIds.set(a.key, row.id);
    }
  }

  private async agentId(key: string): Promise<string> {
    const cached = this.agentIds.get(key);
    if (cached) return cached;
    await this.syncSystemAgents();
    const id = this.agentIds.get(key) ?? this.agentIds.get('orchestrator');
    if (!id) throw new Error(`Unknown agent ${key}`);
    return id;
  }

  async start(params: {
    organizationId: string;
    agentKey: string;
    task: string;
    userId?: string | null;
    executionId?: string | null;
    executionStepId?: string | null;
    conversationId?: string | null;
    input?: unknown;
  }): Promise<AgentRunHandle> {
    const run = await this.prisma.agentRun.create({
      data: {
        organizationId: params.organizationId,
        agentId: await this.agentId(params.agentKey),
        task: params.task,
        userId: params.userId ?? null,
        executionId: params.executionId ?? null,
        executionStepId: params.executionStepId ?? null,
        conversationId: params.conversationId ?? null,
        input: redact(params.input ?? {}, 0, 4000) as Prisma.InputJsonValue,
      },
    });
    RequestContext.set({ agentRunId: run.id });
    await this.events.publish({
      type: 'agent.activity',
      organizationId: params.organizationId,
      executionId: params.executionId,
      conversationId: params.conversationId,
      data: { agentRunId: run.id, agent: params.agentKey, activity: params.task, status: 'running' },
    });
    return { id: run.id, agentKey: params.agentKey, startedAt: Date.now() };
  }

  async complete(organizationId: string, handle: AgentRunHandle, result: { usage?: UsageTracker; output?: unknown; summary?: string; model?: string; executionId?: string | null; conversationId?: string | null }): Promise<void> {
    const usage = result.usage?.snapshot();
    const model = result.model ?? usage?.models[0] ?? null;
    await this.prisma.agentRun.update({
      where: { id: handle.id },
      data: {
        status: 'COMPLETED',
        output: result.output === undefined ? undefined : (redact(result.output, 0, 8000) as Prisma.InputJsonValue),
        summary: result.summary?.slice(0, 2000),
        model,
        promptTokens: usage?.promptTokens ?? 0,
        completionTokens: usage?.completionTokens ?? 0,
        totalTokens: usage?.totalTokens ?? 0,
        llmCalls: usage?.calls ?? 0,
        durationMs: Date.now() - handle.startedAt,
        completedAt: new Date(),
      },
    });
    if (usage && model) this.metrics.recordLlmUsage(model, handle.agentKey, usage.promptTokens, usage.completionTokens, usage.calls);
    await this.events.publish({
      type: 'agent.activity',
      organizationId,
      executionId: result.executionId,
      conversationId: result.conversationId,
      data: { agentRunId: handle.id, agent: handle.agentKey, activity: result.summary ?? 'Completed', status: 'completed' },
    });
  }

  async fail(organizationId: string, handle: AgentRunHandle, error: unknown, usage?: UsageTracker): Promise<void> {
    const u = usage?.snapshot();
    await this.prisma.agentRun
      .update({
        where: { id: handle.id },
        data: {
          status: 'FAILED',
          error: { message: error instanceof Error ? error.message : String(error) },
          promptTokens: u?.promptTokens ?? 0,
          completionTokens: u?.completionTokens ?? 0,
          totalTokens: u?.totalTokens ?? 0,
          llmCalls: u?.calls ?? 0,
          model: u?.models[0] ?? null,
          durationMs: Date.now() - handle.startedAt,
          completedAt: new Date(),
        },
      })
      .catch((err: unknown) => this.logger.error({ err }, 'Failed to record agent run failure'));
    await this.events.publish({ type: 'agent.activity', organizationId, data: { agentRunId: handle.id, agent: handle.agentKey, activity: 'Failed', status: 'failed' } });
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import { tool, type StructuredToolInterface } from '@langchain/core/tools';
import { AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { classifyLlmError, renderPrompt, UsageTracker, type LlmProvider } from '@forgeline/ai';
import { BRAND, ToolError, type MessagePart, type PageContext, type RunCardPart, type StepStatus } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventBus } from '../events/event-bus.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ToolExecutor } from '../tools/tool-executor.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { ExecutionsService } from '../workflow-execution/executions.service';
import { ConnectionResolver } from '../integrations/connection-resolver.service';
import { AgentRunsService } from '../ai/agent-runs.service';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';
import { PlannerService, type StoredProposal } from './planner.service';

export interface OrchestratorTurn {
  organizationId: string;
  userId: string;
  userName: string;
  conversationId: string;
  assistantMessageId: string;
  projectId: string | null;
  pageContext?: PageContext | null;
  isDemo: boolean;
  history: { role: 'USER' | 'ASSISTANT'; content: string }[];
  summary?: string | null;
  userMessage: string;
  signal: AbortSignal;
}

export interface OrchestratorResult {
  content: string;
  parts: MessagePart[];
  proposals: StoredProposal[];
  executionIds: string[];
}

const MAX_TOOL_ROUNDS = 6;

/**
 * The conversational SDLC orchestrator. LangChain tool-calling loop with token
 * streaming: read-only tools gather context, `propose_flow` plans side effects
 * as a durable Flow. All tools run with the requesting user's permissions.
 */
@Injectable()
export class OrchestratorService {
  private readonly logger = new Logger(OrchestratorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly authz: AuthorizationService,
    private readonly tools: ToolExecutor,
    private readonly knowledge: KnowledgeService,
    private readonly executions: ExecutionsService,
    private readonly connections: ConnectionResolver,
    private readonly planner: PlannerService,
    private readonly agentRuns: AgentRunsService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async respond(turn: OrchestratorTurn): Promise<OrchestratorResult> {
    const result: OrchestratorResult = { content: '', parts: [], proposals: [], executionIds: [] };
    if (!this.llm.isConfigured()) return this.fallback(turn, result);

    const usage = new UsageTracker();
    const run = await this.agentRuns.start({
      organizationId: turn.organizationId,
      agentKey: 'orchestrator',
      task: turn.userMessage.slice(0, 200),
      userId: turn.userId,
      conversationId: turn.conversationId,
    });
    const tools = this.buildTools(turn, result);
    const byName = new Map(tools.map((t) => [t.name, t]));
    try {
      const context = await this.systemContext(turn);
      const [system] = await renderPrompt('orchestratorSystem', { context, input: '' });
      const messages: BaseMessage[] = [new SystemMessage(String(system!.content))];
      if (turn.summary) messages.push(new SystemMessage(`Conversation summary so far: ${turn.summary}`));
      for (const h of turn.history.slice(-12)) messages.push(h.role === 'USER' ? new HumanMessage(h.content) : new AIMessage(h.content));
      messages.push(new HumanMessage(turn.userMessage));

      const model = this.llm.chatModel('orchestrator', { streaming: true });
      if (!model.bindTools) throw new ToolError('not_configured', 'The configured chat model does not support tool calling');
      const bound = model.bindTools(tools);
      let buffer = '';
      let lastFlush = Date.now();
      const flush = async (force = false) => {
        if (!buffer || (!force && Date.now() - lastFlush < 60)) return;
        const delta = buffer;
        buffer = '';
        lastFlush = Date.now();
        await this.events.publish({
          type: 'agent.message.delta',
          organizationId: turn.organizationId,
          conversationId: turn.conversationId,
          data: { messageId: turn.assistantMessageId, delta },
        });
      };

      for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
        let aggregate: AIMessageChunk | undefined;
        const stream = await bound.stream(messages, { signal: turn.signal });
        for await (const chunk of stream) {
          aggregate = aggregate ? aggregate.concat(chunk) : chunk;
          const text = typeof chunk.content === 'string' ? chunk.content : '';
          if (text) {
            result.content += text;
            buffer += text;
            await flush();
          }
        }
        await flush(true);
        usage.record(aggregate, this.llm.modelName('orchestrator'));
        const calls = aggregate?.tool_calls ?? [];
        if (!aggregate || !calls.length) break;
        messages.push(new AIMessage({ content: aggregate.content, tool_calls: calls }));
        for (const call of calls) {
          const t = byName.get(call.name);
          const callId = call.id ?? `${call.name}-${round}`;
          const title = TOOL_TITLES[call.name] ?? call.name;
          await this.events.publish({
            type: 'agent.tool.started',
            organizationId: turn.organizationId,
            conversationId: turn.conversationId,
            data: { messageId: turn.assistantMessageId, callId, tool: call.name, title },
          });
          let content: string;
          let ok = true;
          try {
            if (!t) throw new Error(`Unknown tool ${call.name}`);
            const out: unknown = await t.invoke(call.args);
            content = typeof out === 'string' ? out : JSON.stringify(out);
          } catch (err) {
            ok = false;
            content = `Error: ${(err as Error).message}`;
          }
          const summary = content.startsWith('Error') ? content.slice(0, 200) : undefined;
          result.parts.push({ type: 'tool_call', callId, tool: call.name, title, status: ok ? 'succeeded' : 'failed', summary });
          await this.events.publish({
            type: 'agent.tool.completed',
            organizationId: turn.organizationId,
            conversationId: turn.conversationId,
            data: {
              messageId: turn.assistantMessageId,
              callId,
              tool: call.name,
              title,
              status: ok ? 'succeeded' : 'failed',
              summary: summary ?? null,
            },
          });
          messages.push(new ToolMessage({ content: content.slice(0, 20_000), tool_call_id: callId }));
        }
        if (result.content && !result.content.endsWith('\n')) {
          result.content += '\n\n';
          buffer += '\n\n';
        }
      }
      if (!result.content.trim()) result.content = result.proposals.length ? 'Here is the plan I prepared.' : 'Done.';
      await this.agentRuns.complete(turn.organizationId, run, {
        usage,
        summary: `Responded${result.proposals.length ? ` with ${result.proposals.length} flow proposal(s)` : ''}`,
        conversationId: turn.conversationId,
        output: { tools: result.parts.filter((p) => p.type === 'tool_call').length },
      });
      return result;
    } catch (err) {
      await this.agentRuns.fail(turn.organizationId, run, err, usage);
      const e = classifyLlmError(err);
      if (e.kind === 'cancelled') throw e;
      result.parts.push({ type: 'error', message: e.message, retryable: e.retryable });
      result.content ||= `I couldn't complete that: ${e.message}`;
      return result;
    }
  }

  private async systemContext(turn: OrchestratorTurn): Promise<string> {
    const [projects, connected, org] = await Promise.all([
      this.prisma.project.findMany({
        where: { organizationId: turn.organizationId, deletedAt: null },
        select: { id: true, name: true, key: true },
        take: 50,
      }),
      this.connections.connectedProviders(turn.organizationId),
      this.prisma.organization.findUniqueOrThrow({ where: { id: turn.organizationId }, select: { name: true } }),
    ]);
    const current = projects.find((p) => p.id === turn.projectId);
    return [
      `Organization: ${org.name}${turn.isDemo ? ' (DEMO workspace — every tool result is simulated and must be described as simulated)' : ''}`,
      `User: ${turn.userName}`,
      `Current project: ${current ? `${current.name} (${current.key}, id ${current.id})` : 'none selected'}`,
      `Projects: ${projects.map((p) => `${p.name} [${p.key}] id=${p.id}`).join('; ') || 'none'}`,
      `Connected integrations: ${connected.join(', ') || 'none'}`,
      turn.pageContext
        ? `The user is looking at: ${turn.pageContext.title ?? turn.pageContext.route}${turn.pageContext.entity ? ` (${turn.pageContext.entity.kind} ${turn.pageContext.entity.label ?? ''} id=${turn.pageContext.entity.id})` : ''}`
        : '',
      `Date: ${new Date().toISOString().slice(0, 10)}`,
    ]
      .filter(Boolean)
      .join('\n');
  }

  private buildTools(turn: OrchestratorTurn, result: OrchestratorResult): StructuredToolInterface[] {
    const org = turn.organizationId;
    const can = (permission: Parameters<AuthorizationService['hasPermission']>[2], projectId?: string | null) =>
      this.authz.hasPermission(turn.userId, org, permission, projectId);
    const projectOf = (id?: string | null) => id ?? turn.projectId;
    const invoke = async (name: string, input: unknown, projectId: string | null) => {
      const res = await this.tools.execute({
        tool: name,
        input,
        organizationId: org,
        userId: turn.userId,
        projectId,
        idempotencyKey: `chat:${turn.assistantMessageId}:${name}`,
        mode: turn.isDemo ? 'DEMO' : 'LIVE',
        signal: turn.signal,
      });
      return res.result;
    };

    return [
      tool(
        async () => {
          const projects = await this.prisma.project.findMany({
            where: { organizationId: org, deletedAt: null },
            select: {
              id: true,
              name: true,
              key: true,
              description: true,
              repositories: { where: { deletedAt: null }, select: { fullName: true } },
              environments: { select: { name: true, type: true, url: true } },
            },
          });
          return projects;
        },
        { name: 'list_projects', description: 'List projects with repositories and environments.', schema: z.object({}) },
      ),
      tool(
        async ({ query, projectId }) => {
          if (!(await can('knowledge:read'))) return 'Permission denied: knowledge:read';
          const res = await this.knowledge.retrieve({ organizationId: org, projectId: projectOf(projectId), query, k: 6 });
          if (res.sources.length)
            result.parts.push({
              type: 'sources',
              sources: res.sources.map((s) => ({
                documentId: s.documentId,
                title: s.title,
                score: s.score,
                sourceType: s.sourceType,
                url: s.url,
              })),
            });
          return res.context;
        },
        {
          name: 'search_knowledge',
          description: 'Semantic search over project documentation, code, tickets, specs and past runs.',
          schema: z.object({ query: z.string(), projectId: z.string().uuid().nullable().optional() }),
        },
      ),
      tool(
        async ({ status, projectId }) => {
          if (!(await can('workflow:read'))) return 'Permission denied: workflow:read';
          return this.prisma.workflowExecution.findMany({
            where: { organizationId: org, ...(status && { status }), ...(projectId && { projectId }) },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              id: true,
              title: true,
              status: true,
              mode: true,
              createdAt: true,
              completedAt: true,
              error: true,
              project: { select: { name: true } },
            },
          });
        },
        {
          name: 'list_runs',
          description: 'List recent workflow runs, optionally filtered by status.',
          schema: z.object({
            status: z
              .enum(['PENDING', 'RUNNING', 'WAITING_APPROVAL', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'COMPENSATING', 'COMPENSATED'])
              .nullable()
              .optional(),
            projectId: z.string().uuid().nullable().optional(),
          }),
        },
      ),
      tool(
        async ({ runId }) => {
          if (!(await can('workflow:read'))) return 'Permission denied: workflow:read';
          const e = await this.prisma.workflowExecution.findFirst({
            where: { id: runId, organizationId: org },
            select: {
              id: true,
              title: true,
              status: true,
              mode: true,
              error: true,
              steps: {
                orderBy: { position: 'asc' },
                select: { id: true, name: true, status: true, summary: true, error: true, tool: true, attempt: true, iteration: true },
              },
            },
          });
          if (!e) return 'Run not found';
          result.parts.push(toRunCard(e));
          const logs = await this.prisma.executionLog.findMany({
            where: { executionId: runId, level: { in: ['WARN', 'ERROR'] } },
            orderBy: { createdAt: 'desc' },
            take: 15,
            select: { level: true, message: true, createdAt: true },
          });
          return { ...e, recentWarnings: logs };
        },
        {
          name: 'get_run',
          description: 'Get a run with step statuses, summaries, errors and recent warnings (use to explain failures).',
          schema: z.object({ runId: z.string().uuid() }),
        },
      ),
      tool(
        async ({ key, projectId }) => {
          const r = await invoke('ticket.get', { key }, projectOf(projectId));
          return r.output;
        },
        {
          name: 'get_ticket',
          description: `Read a Jira/Trello/${BRAND.name} ticket by key.`,
          schema: z.object({ key: z.string(), projectId: z.string().uuid().nullable().optional() }),
        },
      ),
      tool(
        async ({ projectId }) => {
          const r = await invoke('github.listPullRequests', { state: 'open' }, projectOf(projectId));
          return r.output;
        },
        {
          name: 'list_pull_requests',
          description: "List open pull requests of the project's repository.",
          schema: z.object({ projectId: z.string().uuid().nullable().optional() }),
        },
      ),
      tool(
        async () =>
          this.prisma.approval.findMany({
            where: { organizationId: org, status: 'PENDING' },
            select: {
              id: true,
              title: true,
              action: true,
              riskLevel: true,
              createdAt: true,
              execution: { select: { id: true, title: true } },
            },
            take: 20,
          }),
        { name: 'list_pending_approvals', description: 'List approvals waiting for a decision.', schema: z.object({}) },
      ),
      tool(
        async ({ projectId, environment }) =>
          this.prisma.deployment.findMany({
            where: { organizationId: org, ...(projectId && { projectId }), ...(environment && { environment: { name: environment } }) },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: {
              id: true,
              version: true,
              status: true,
              error: true,
              simulated: true,
              createdAt: true,
              executionId: true,
              environment: { select: { name: true } },
              healthChecks: true,
              smokeTests: true,
            },
          }),
        {
          name: 'list_deployments',
          description: 'Recent deployments with health/smoke results and errors.',
          schema: z.object({ projectId: z.string().uuid().nullable().optional(), environment: z.string().nullable().optional() }),
        },
      ),
      tool(
        async ({ request, projectId, startImmediately }) => {
          const pid = projectOf(projectId);
          if (!(await can('workflow:execute', pid))) return 'Permission denied: you cannot run flows in this project';
          const { proposal, part } = await this.planner.plan({ organizationId: org, userId: turn.userId, projectId: pid, request });
          result.proposals.push(proposal);
          const safeToStart = startImmediately && part.missingIntegrations.length === 0;
          if (safeToStart) {
            const exec = await this.executions.start({
              organizationId: org,
              projectId: pid,
              userId: turn.userId,
              title: proposal.title,
              definition: proposal.definition,
              input: proposal.input,
              template: proposal.template,
              conversationId: turn.conversationId,
              triggerSource: 'CHAT',
              idempotencyKey: `proposal:${proposal.id}`,
            });
            result.executionIds.push(exec.id);
            part.state = 'started';
            part.executionId = exec.id;
            result.parts.push(part);
            const steps = await this.prisma.workflowExecutionStep.findMany({
              where: { executionId: exec.id },
              orderBy: { position: 'asc' },
              select: { stepKey: true, name: true, status: true, agent: true },
            });
            result.parts.push({
              type: 'run',
              executionId: exec.id,
              title: exec.title,
              status: exec.status,
              mode: exec.mode,
              steps: steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status as StepStatus, agent: s.agent })),
            });
            return {
              started: true,
              runId: exec.id,
              title: proposal.title,
              steps: part.steps.length,
              approvalsRequired: part.approvalsRequired,
            };
          }
          result.parts.push(part);
          return {
            started: false,
            proposalId: proposal.id,
            title: proposal.title,
            summary: proposal.summary,
            steps: part.steps.map((s) => s.name),
            approvalsRequired: part.approvalsRequired,
            missingIntegrations: part.missingIntegrations,
            note: 'The user can review and start this flow from the proposal card.',
          };
        },
        {
          name: 'propose_flow',
          description:
            'Plan an engineering workflow (ticket, spec, code, review, QA, CI, deploy, docs, notify…) for the request. Set startImmediately=true only when the user explicitly asked to do it now; gates and approvals are enforced automatically.',
          schema: z.object({
            request: z.string().describe('The full engineering request'),
            projectId: z.string().uuid().nullable().optional(),
            startImmediately: z.boolean().default(false),
          }),
        },
      ),
    ];
  }

  /** No LLM configured: honest keyword-based planning instead of pretending to reason. */
  private async fallback(turn: OrchestratorTurn, result: OrchestratorResult): Promise<OrchestratorResult> {
    const actionable =
      /\b(create|implement|build|deploy|review|run|generate|write|fix|notify|roll ?back|ship|document|plan|analy[sz]e)\b/i.test(
        turn.userMessage,
      );
    if (!actionable || !(await this.authz.hasPermission(turn.userId, turn.organizationId, 'workflow:execute', turn.projectId))) {
      result.content = `${BRAND.assistantName} needs an AI provider for open-ended conversation. Ask an administrator to set \`OPENAI_API_KEY\`. You can still run Flows from the command palette (⌘K) or the Flows page.`;
      return result;
    }
    const { proposal, part } = await this.planner.plan({
      organizationId: turn.organizationId,
      userId: turn.userId,
      projectId: turn.projectId,
      request: turn.userMessage,
    });
    result.proposals.push(proposal);
    result.parts.push(part);
    result.content = `${turn.isDemo ? '**Demo workspace** — results will be simulated.\n\n' : ''}The AI provider is not configured, so I matched your request to the **${part.title.split(':')[0]}** flow by keywords. Review the plan below and start it when ready.`;
    return result;
  }
}

const TOOL_TITLES: Record<string, string> = {
  list_projects: 'Looking up projects',
  search_knowledge: 'Searching project knowledge',
  list_runs: 'Checking recent runs',
  get_run: 'Inspecting run',
  get_ticket: 'Reading ticket',
  list_pull_requests: 'Listing pull requests',
  list_pending_approvals: 'Checking approvals',
  list_deployments: 'Checking deployments',
  propose_flow: 'Planning workflow',
};

function toRunCard(e: {
  id: string;
  title: string;
  status: string;
  mode: string;
  steps: { name: string; status: string; tool: string | null }[];
}): RunCardPart {
  return {
    type: 'run',
    executionId: e.id,
    title: e.title,
    status: e.status as RunCardPart['status'],
    mode: e.mode as 'LIVE' | 'DEMO',
    steps: e.steps.map((s, i) => ({ key: `${i}`, name: s.name, status: s.status as StepStatus })),
  };
}

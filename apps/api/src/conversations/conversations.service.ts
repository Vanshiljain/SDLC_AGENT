import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import type { Prisma } from '@forgeline/database';
import { renderPrompt, UsageTracker, type LlmProvider } from '@forgeline/ai';
import type { DomainEvent, FlowProposalPart, MessagePart, PageContext, StepStatus } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { AppException } from '../common/errors';
import { EventBus } from '../events/event-bus.service';
import { AuditService } from '../audit/audit.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ExecutionsService } from '../workflow-execution/executions.service';
import { OrchestratorService } from '../agents/orchestrator.service';
import { PlannerService, type StoredProposal } from '../agents/planner.service';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';
import type { AuthContext } from '../common/auth/auth-context';

interface ConversationContext {
  proposals?: Record<string, StoredProposal>;
  pageContext?: PageContext | null;
}

@Injectable()
export class ConversationsService implements OnModuleInit {
  private readonly logger = new Logger(ConversationsService.name);
  private readonly inflight = new Map<string, AbortController>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    private readonly audit: AuditService,
    private readonly authz: AuthorizationService,
    private readonly executions: ExecutionsService,
    private readonly orchestrator: OrchestratorService,
    private readonly planner: PlannerService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  async onModuleInit(): Promise<void> {
    // Turns interrupted by a restart are marked so the UI can offer a retry.
    await this.prisma.message.updateMany({ where: { status: 'streaming', updatedAt: { lt: new Date(Date.now() - 60_000) } }, data: { status: 'interrupted' } }).catch(() => undefined);
    this.events.on<{ status: string; title: string; conversationId?: string | null; error?: { message?: string } | null }>('workflow.completed', (e) => this.onRunFinished(e));
    this.events.on<{ status: string; title: string; conversationId?: string | null; error?: { message?: string } | null }>('workflow.failed', (e) => this.onRunFinished(e));
  }

  private async load(auth: AuthContext, id: string) {
    const c = await this.prisma.conversation.findFirst({ where: { id, organizationId: auth.organizationId, userId: auth.userId } });
    if (!c) throw AppException.notFound('Conversation', id);
    return c;
  }

  list(auth: AuthContext) {
    return this.prisma.conversation.findMany({
      where: { organizationId: auth.organizationId, userId: auth.userId, archivedAt: null },
      orderBy: { updatedAt: 'desc' },
      take: 100,
      select: { id: true, title: true, projectId: true, updatedAt: true, createdAt: true, project: { select: { id: true, name: true, key: true } } },
    });
  }

  async create(auth: AuthContext, projectId?: string | null, title?: string) {
    if (projectId) await this.authz.assertProjectInOrg(auth.organizationId, projectId);
    return this.prisma.conversation.create({ data: { organizationId: auth.organizationId, userId: auth.userId, projectId: projectId ?? null, title: title ?? 'New conversation' } });
  }

  async get(auth: AuthContext, id: string) {
    const c = await this.load(auth, id);
    const messages = await this.prisma.message.findMany({ where: { conversationId: id }, orderBy: { createdAt: 'asc' }, take: 500 });
    const { proposals: _p, ...context } = (c.context ?? {}) as ConversationContext;
    return { ...c, context, messages };
  }

  async update(auth: AuthContext, id: string, data: { title?: string; projectId?: string | null; archived?: boolean }) {
    await this.load(auth, id);
    if (data.projectId) await this.authz.assertProjectInOrg(auth.organizationId, data.projectId);
    return this.prisma.conversation.update({
      where: { id },
      data: { ...(data.title && { title: data.title }), ...(data.projectId !== undefined && { projectId: data.projectId }), ...(data.archived !== undefined && { archivedAt: data.archived ? new Date() : null }) },
    });
  }

  /** Persist the user message and run the agent turn asynchronously (streamed over WebSocket). */
  async send(auth: AuthContext, id: string, content: string, pageContext?: PageContext | null) {
    const conversation = await this.load(auth, id);
    await this.authz.assertPermission(auth, 'agent:use', conversation.projectId);
    if (this.inflight.has(id)) throw AppException.conflict('The agent is still responding in this conversation', 'TURN_IN_PROGRESS');
    const userMessage = await this.prisma.message.create({ data: { conversationId: id, role: 'USER', content, parts: [{ type: 'text', text: content }] as Prisma.InputJsonValue } });
    const assistant = await this.prisma.message.create({ data: { conversationId: id, role: 'ASSISTANT', content: '', parts: [], status: 'streaming' } });
    const projectId = pageContext?.projectId ?? conversation.projectId;
    await this.prisma.conversation.update({ where: { id }, data: { updatedAt: new Date(), ...(projectId !== conversation.projectId && projectId ? { projectId } : {}), context: { ...(conversation.context as object), pageContext: pageContext ?? null } as Prisma.InputJsonValue } });
    const abort = new AbortController();
    this.inflight.set(id, abort);
    void this.runTurn(auth, id, assistant.id, content, pageContext ?? null, projectId ?? null, abort).finally(() => this.inflight.delete(id));
    return { userMessage, assistantMessage: assistant };
  }

  cancel(auth: AuthContext, id: string) {
    const c = this.inflight.get(id);
    if (c) c.abort();
    return { cancelled: Boolean(c) };
  }

  private async runTurn(auth: AuthContext, conversationId: string, messageId: string, content: string, pageContext: PageContext | null, projectId: string | null, abort: AbortController) {
    try {
      const conversation = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
      const history = await this.prisma.message.findMany({ where: { conversationId, status: 'complete', id: { not: messageId } }, orderBy: { createdAt: 'asc' }, take: 40, select: { role: true, content: true } });
      const result = await this.orchestrator.respond({
        organizationId: auth.organizationId,
        userId: auth.userId,
        userName: auth.name,
        conversationId,
        assistantMessageId: messageId,
        projectId,
        pageContext,
        isDemo: auth.isDemoOrg,
        history: history.filter((h) => h.role === 'USER' || h.role === 'ASSISTANT').slice(0, -1) as { role: 'USER' | 'ASSISTANT'; content: string }[],
        summary: conversation.summary,
        userMessage: content,
        signal: abort.signal,
      });
      const parts: MessagePart[] = [{ type: 'text', text: result.content }, ...result.parts];
      if (result.proposals.length) {
        const ctx = (conversation.context ?? {}) as ConversationContext;
        const proposals = { ...(ctx.proposals ?? {}) };
        for (const p of result.proposals) proposals[p.id] = p;
        await this.prisma.conversation.update({ where: { id: conversationId }, data: { context: { ...ctx, proposals } as unknown as Prisma.InputJsonValue } });
      }
      const msg = await this.prisma.message.update({ where: { id: messageId }, data: { content: result.content, parts: parts as unknown as Prisma.InputJsonValue, status: 'complete', executionId: result.executionIds[0] ?? null } });
      await this.events.publish({ type: 'agent.message.completed', organizationId: auth.organizationId, conversationId, data: { messageId, message: msg as unknown as Record<string, unknown> } });
      await this.maybeTitle(conversationId, content);
      await this.maybeCompact(conversationId);
    } catch (err) {
      const cancelled = abort.signal.aborted;
      const msg = await this.prisma.message.update({
        where: { id: messageId },
        data: { status: cancelled ? 'cancelled' : 'error', parts: [{ type: 'error', message: cancelled ? 'Response cancelled' : (err as Error).message, retryable: true }] as Prisma.InputJsonValue, content: cancelled ? 'Response cancelled.' : 'Something went wrong while responding.' },
      });
      await this.events.publish({ type: 'agent.message.completed', organizationId: auth.organizationId, conversationId, data: { messageId, message: msg as unknown as Record<string, unknown> } });
      if (!cancelled) this.logger.error({ err, conversationId }, 'Agent turn failed');
    }
  }

  private async maybeTitle(conversationId: string, firstMessage: string) {
    const c = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    if (c.title !== 'New conversation') return;
    let title = firstMessage.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (this.llm.isConfigured()) {
      try {
        const messages = await renderPrompt('conversationTitle', { message: firstMessage.slice(0, 1000) });
        const res = await this.llm.chatModel('fast').invoke(messages);
        const text = typeof res.content === 'string' ? res.content.trim().replace(/^["']|["']$/g, '') : '';
        if (text) title = text.slice(0, 80);
      } catch {
        /* keep the truncated message as title */
      }
    }
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { title } });
  }

  /** Memory compaction: summarise older turns once the conversation grows long. */
  private async maybeCompact(conversationId: string) {
    if (!this.llm.isConfigured()) return;
    const count = await this.prisma.message.count({ where: { conversationId } });
    if (count < 30 || count % 10 !== 0) return;
    const c = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId } });
    const older = await this.prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'asc' }, take: count - 12, select: { role: true, content: true } });
    const usage = new UsageTracker();
    const messages = await renderPrompt('conversationSummary', { summary: c.summary ?? '(none)', messages: older.map((m) => `${m.role}: ${m.content.slice(0, 1500)}`).join('\n').slice(-30_000) });
    const res = await this.llm.chatModel('fast').invoke(messages);
    usage.record(res);
    await this.prisma.conversation.update({ where: { id: conversationId }, data: { summary: typeof res.content === 'string' ? res.content.slice(0, 4000) : c.summary } });
  }

  /** Start a flow proposed in this conversation. Only server-stored proposals can be started. */
  async startProposal(auth: AuthContext, conversationId: string, proposalId: string, inputOverrides?: Record<string, unknown>) {
    const c = await this.load(auth, conversationId);
    const proposal = ((c.context ?? {}) as ConversationContext).proposals?.[proposalId];
    if (!proposal) throw AppException.notFound('Proposal', proposalId);
    const exec = await this.executions.start({
      organizationId: auth.organizationId,
      projectId: proposal.projectId,
      userId: auth.userId,
      title: proposal.title,
      definition: proposal.definition,
      input: { ...proposal.input, ...inputOverrides },
      template: proposal.template,
      conversationId,
      triggerSource: 'CHAT',
      idempotencyKey: `proposal:${proposal.id}`,
    });
    await this.updateProposalPart(conversationId, proposalId, { state: 'started', executionId: exec.id });
    const steps = await this.prisma.workflowExecutionStep.findMany({ where: { executionId: exec.id }, orderBy: { position: 'asc' }, select: { stepKey: true, name: true, status: true, agent: true } });
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        executionId: exec.id,
        content: `Started **${exec.title}**${exec.mode === 'DEMO' ? ' (simulated — demo workspace)' : ''}. I'll keep you posted here; approvals will appear when a gate is reached.`,
        parts: [
          { type: 'text', text: `Started **${exec.title}**${exec.mode === 'DEMO' ? ' (simulated — demo workspace)' : ''}. I'll keep you posted here; approvals will appear when a gate is reached.` },
          { type: 'run', executionId: exec.id, title: exec.title, status: exec.status, mode: exec.mode, steps: steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status as StepStatus, agent: s.agent })) },
        ] as Prisma.InputJsonValue,
      },
    });
    await this.events.publish({ type: 'agent.message.completed', organizationId: auth.organizationId, conversationId, data: { messageId: message.id, message: message as unknown as Record<string, unknown> } });
    return { execution: exec, message };
  }

  async dismissProposal(auth: AuthContext, conversationId: string, proposalId: string) {
    await this.load(auth, conversationId);
    await this.updateProposalPart(conversationId, proposalId, { state: 'dismissed' });
    return { dismissed: true };
  }

  /** Return the stored proposal definition (for "Edit in builder"). */
  async proposal(auth: AuthContext, conversationId: string, proposalId: string) {
    const c = await this.load(auth, conversationId);
    const p = ((c.context ?? {}) as ConversationContext).proposals?.[proposalId];
    if (!p) throw AppException.notFound('Proposal', proposalId);
    return p;
  }

  private async updateProposalPart(conversationId: string, proposalId: string, patch: Partial<FlowProposalPart>) {
    const messages = await this.prisma.message.findMany({ where: { conversationId, role: 'ASSISTANT' }, orderBy: { createdAt: 'desc' }, take: 50 });
    for (const m of messages) {
      const parts = (m.parts ?? []) as unknown as MessagePart[];
      const idx = parts.findIndex((p) => p.type === 'flow_proposal' && p.proposalId === proposalId);
      if (idx >= 0) {
        parts[idx] = { ...(parts[idx] as FlowProposalPart), ...patch };
        await this.prisma.message.update({ where: { id: m.id }, data: { parts: parts as unknown as Prisma.InputJsonValue } });
        return;
      }
    }
  }

  /** "Notify the user": post the outcome of chat-started runs back into the conversation. */
  private async onRunFinished(e: DomainEvent<{ status: string; title: string; conversationId?: string | null; error?: { message?: string } | null }>) {
    const conversationId = e.data.conversationId;
    if (!conversationId || !e.executionId) return;
    const exec = await this.prisma.workflowExecution.findUnique({
      where: { id: e.executionId },
      include: { steps: { orderBy: { position: 'asc' }, select: { stepKey: true, name: true, status: true, agent: true, summary: true } }, externalResources: { select: { type: true, key: true, url: true, title: true } } },
    });
    if (!exec) return;
    const ok = exec.status === 'COMPLETED';
    const links = exec.externalResources.filter((r) => r.url).slice(0, 6).map((r) => `- ${r.type.replace(/_/g, ' ').toLowerCase()}: [${r.key ?? r.title}](${r.url})`).join('\n');
    const text = ok
      ? `✅ **${exec.title}** completed${exec.mode === 'DEMO' ? ' (simulated)' : ''}.${links ? `\n\n${links}` : ''}`
      : `❌ **${exec.title}** failed: ${(exec.error as { message?: string } | null)?.message ?? 'see the run for details'}. You can retry the failed step from the run page.`;
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        role: 'ASSISTANT',
        executionId: exec.id,
        content: text,
        parts: [{ type: 'text', text }, { type: 'run', executionId: exec.id, title: exec.title, status: exec.status, mode: exec.mode, steps: exec.steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status as StepStatus, agent: s.agent })) }] as Prisma.InputJsonValue,
      },
    });
    await this.events.publish({ type: 'agent.message.completed', organizationId: e.organizationId, conversationId, data: { messageId: message.id, message: message as unknown as Record<string, unknown> } });
  }
}

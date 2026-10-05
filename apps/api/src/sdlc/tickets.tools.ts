import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Prisma } from '@forgeline/database';
import { defineLooseTool, type AnySdlcTool, type ToolExecutionContext } from '@forgeline/integrations';
import { ToolError, type TaskPriority, type TaskStatus } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { ToolRegistry } from '../tools/tool-registry.service';

type Provider = 'JIRA' | 'TRELLO' | 'FORGELINE';

const PRIORITY_MAP: Record<string, TaskPriority> = { Highest: 'HIGHEST', High: 'HIGH', Medium: 'MEDIUM', Low: 'LOW', Lowest: 'LOWEST' };
const STATUS_MAP: Record<string, TaskStatus> = { 'to do': 'TODO', todo: 'TODO', 'in progress': 'IN_PROGRESS', 'in review': 'IN_REVIEW', review: 'IN_REVIEW', done: 'DONE', closed: 'DONE', blocked: 'BLOCKED' };

/**
 * Provider-neutral ticket tools used by Flows. They delegate to the Jira or
 * Trello adapters (keeping their idempotency guarantees) and mirror tickets as
 * Forgeline Tasks. Without a tracker connected they create a Forgeline task
 * and say so explicitly — never pretending a Jira ticket exists.
 */
@Injectable()
export class TicketTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
  ) {}

  private async provider(ctx: ToolExecutionContext): Promise<Provider> {
    const preferred = ctx.project?.settings.ticketProvider;
    const connected = await ctx.clients.connected();
    if (preferred === 'JIRA' && connected.includes('JIRA')) return 'JIRA';
    if (preferred === 'TRELLO' && connected.includes('TRELLO')) return 'TRELLO';
    if (!preferred && connected.includes('JIRA')) return 'JIRA';
    if (!preferred && connected.includes('TRELLO')) return 'TRELLO';
    return 'FORGELINE';
  }

  private tool(name: string): AnySdlcTool {
    const t = this.registry.get(name);
    if (!t) throw new ToolError('internal', `Tool ${name} not registered`);
    return t;
  }

  private async mirrorTask(ctx: ToolExecutionContext, provider: Provider, key: string, data: { title: string; description?: string; url?: string | null; priority?: string; status?: TaskStatus }) {
    if (!ctx.project) return null;
    return this.prisma.task.upsert({
      where: { organizationId_externalProvider_externalKey: { organizationId: ctx.organizationId, externalProvider: provider, externalKey: key } },
      create: {
        organizationId: ctx.organizationId,
        projectId: ctx.project.id,
        title: data.title.slice(0, 300),
        description: data.description,
        priority: PRIORITY_MAP[data.priority ?? 'Medium'] ?? 'MEDIUM',
        status: data.status ?? 'TODO',
        externalProvider: provider,
        externalKey: key,
        externalUrl: data.url ?? null,
        executionId: ctx.executionId ?? null,
        createdById: ctx.userId,
      },
      update: { ...(data.status && { status: data.status }), ...(data.url && { externalUrl: data.url }) },
    });
  }

  onModuleInit(): void {
    const self = this;
    const createInput = z.object({
      summary: z.string().min(3).max(255),
      description: z.string().max(30_000).default(''),
      issueType: z.string().max(40).optional(),
      priority: z.string().max(20).optional(),
      labels: z.array(z.string()).max(20).default([]),
      acceptanceCriteria: z.array(z.string()).max(50).default([]),
    });

    this.registry.register(
      defineLooseTool({
        name: 'ticket.create',
        title: 'Create ticket',
        description: "Create a ticket in the project's tracker (Jira or Trello); falls back to a Forgeline task when none is connected.",
        category: 'jira',
        provider: null,
        agent: 'planning',
        inputSchema: createInput,
        permission: 'ticket:write',
        risk: 'write',
        sideEffects: true,
        approvalAction: 'ticket.create',
        async execute(input, ctx) {
          const provider = await self.provider(ctx);
          if (provider === 'JIRA') {
            const res = await self.tool('jira.createIssue').execute(
              { summary: input.summary, description: input.description, issueType: input.issueType, labels: input.labels, priority: ['Highest', 'High', 'Medium', 'Low', 'Lowest'].includes(input.priority ?? '') ? input.priority : undefined },
              ctx,
            );
            const o = res.output as { key: string; url: string; id: string; created: boolean };
            await self.mirrorTask(ctx, 'JIRA', o.key, { title: input.summary, description: input.description, url: o.url, priority: input.priority });
            return { ...res, output: { ...o, provider } };
          }
          if (provider === 'TRELLO') {
            const res = await self.tool('trello.createCard').execute({ name: input.summary, description: input.description }, ctx);
            const o = res.output as { id: string; url: string };
            await self.mirrorTask(ctx, 'TRELLO', o.id, { title: input.summary, description: input.description, url: o.url, priority: input.priority });
            return { ...res, output: { key: o.id, id: o.id, url: o.url, created: true, provider } };
          }
          if (!ctx.project) throw new ToolError('validation', 'A project is required to create a Forgeline task', { retryable: false });
          const existing = await self.prisma.task.findFirst({ where: { organizationId: ctx.organizationId, executionId: ctx.executionId ?? undefined, externalProvider: 'FORGELINE', title: input.summary.slice(0, 300) } });
          let key = existing?.externalKey;
          if (!key) {
            const count = await self.prisma.task.count({ where: { projectId: ctx.project.id, externalProvider: 'FORGELINE' } });
            key = `${ctx.project.key}-T${count + 1}`;
            await self.mirrorTask(ctx, 'FORGELINE', key, { title: input.summary, description: input.description, priority: input.priority });
          }
          return {
            output: { key, id: key, url: null, created: !existing, provider },
            summary: `No issue tracker connected — created Forgeline task ${key}`,
          };
        },
        async simulate(input, ctx) {
          const res = await self.tool('jira.createIssue').simulate!({ summary: input.summary, description: input.description, labels: input.labels }, ctx);
          return { ...res, output: { ...(res.output as object), provider: 'JIRA' } };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'ticket.get',
        title: 'Get ticket',
        description: 'Read a ticket (Jira issue, Trello card or Forgeline task) by key.',
        category: 'jira',
        provider: null,
        agent: 'planning',
        inputSchema: z.object({ key: z.string().min(1).max(100) }),
        permission: 'project:read',
        risk: 'read',
        sideEffects: false,
        async execute(input, ctx) {
          if (/^[A-Z][A-Z0-9_]+-\d+$/.test(input.key) && (await ctx.clients.connected()).includes('JIRA')) {
            const res = await self.tool('jira.getIssue').execute({ key: input.key }, ctx);
            return { ...res, output: { ...(res.output as object), provider: 'JIRA' } };
          }
          const task = await self.prisma.task.findFirst({ where: { organizationId: ctx.organizationId, externalKey: input.key, deletedAt: null } });
          if (task?.externalProvider === 'TRELLO') {
            const trello = await ctx.clients.trello();
            const card = await trello.getCard(task.externalKey!);
            return { output: { key: input.key, summary: card.name, description: card.desc, status: task.status, url: card.shortUrl ?? card.url, labels: [], type: 'Card', provider: 'TRELLO' }, summary: `Card "${card.name}"` };
          }
          if (task) {
            return { output: { key: input.key, summary: task.title, description: task.description ?? '', status: task.status, url: task.externalUrl, labels: [], type: 'Task', provider: task.externalProvider ?? 'FORGELINE' }, summary: `${input.key} [${task.status}] ${task.title}` };
          }
          throw new ToolError('not_found', `Ticket ${input.key} not found`, { retryable: false });
        },
        async simulate(input) {
          return { simulated: true, output: { key: input.key, summary: 'Implement password reset', description: 'Demo ticket (simulated).', status: 'To Do', url: null, labels: ['auth'], type: 'Story', provider: 'JIRA' }, summary: `[Simulated] ${input.key} [To Do]` };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'ticket.comment',
        title: 'Comment on ticket',
        description: 'Add a comment to the ticket in its tracker.',
        category: 'jira',
        provider: null,
        agent: 'planning',
        inputSchema: z.object({ key: z.string().min(1).max(100), body: z.string().min(1).max(30_000) }),
        permission: 'ticket:write',
        risk: 'write',
        sideEffects: true,
        async execute(input, ctx) {
          const task = await self.prisma.task.findFirst({ where: { organizationId: ctx.organizationId, externalKey: input.key, deletedAt: null } });
          if (task?.externalProvider === 'TRELLO') return self.tool('trello.addComment').execute({ cardId: input.key, text: input.body }, ctx);
          if (task?.externalProvider === 'FORGELINE' || (!task && !(await ctx.clients.connected()).includes('JIRA'))) {
            if (!task) throw new ToolError('not_found', `Ticket ${input.key} not found`, { retryable: false });
            await self.prisma.task.update({ where: { id: task.id }, data: { description: `${task.description ?? ''}\n\n---\n**${new Date().toISOString()}** ${input.body}`.slice(-60_000) } });
            return { output: { key: input.key, provider: 'FORGELINE' }, summary: `Added note to Forgeline task ${input.key}` };
          }
          return self.tool('jira.addComment').execute({ key: input.key, body: input.body }, ctx);
        },
        async simulate(input) {
          return { simulated: true, output: { key: input.key }, summary: `[Simulated] Commented on ${input.key}` };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'ticket.transition',
        title: 'Move ticket',
        description: 'Move the ticket to a status (To Do, In Progress, In Review, Done).',
        category: 'jira',
        provider: null,
        agent: 'planning',
        inputSchema: z.object({ key: z.string().min(1).max(100), status: z.string().min(2).max(60) }),
        permission: 'ticket:write',
        risk: 'write',
        sideEffects: true,
        async execute(input, ctx) {
          const task = await self.prisma.task.findFirst({ where: { organizationId: ctx.organizationId, externalKey: input.key, deletedAt: null } });
          const mapped = STATUS_MAP[input.status.toLowerCase()];
          if (task && mapped) await self.prisma.task.update({ where: { id: task.id }, data: { status: mapped } });
          if (task?.externalProvider === 'TRELLO') return self.tool('trello.moveCard').execute({ cardId: input.key, listName: input.status }, ctx);
          if (task?.externalProvider === 'FORGELINE' || (!task && !(await ctx.clients.connected()).includes('JIRA'))) {
            if (!task) throw new ToolError('not_found', `Ticket ${input.key} not found`, { retryable: false });
            return { output: { key: input.key, status: mapped ?? task.status, transitioned: Boolean(mapped) }, summary: `Forgeline task ${input.key} → ${mapped ?? task.status}` };
          }
          return self.tool('jira.transitionIssue').execute({ key: input.key, status: input.status }, ctx);
        },
        async simulate(input) {
          return { simulated: true, output: { key: input.key, status: input.status, transitioned: true }, summary: `[Simulated] Moved ${input.key} → ${input.status}` };
        },
      }),
    );
  }
}

export type { Prisma };

import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { documentDraftSchema } from '@forgeline/ai';
import { defineLooseTool, type ToolExecutionContext } from '@forgeline/integrations';
import { PrismaService } from '../common/prisma/prisma.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { NotificationsService } from '../notifications/notifications.service';
import { AgentTaskRunner, forPrompt } from './agent-task-runner.service';

/** Documentation agent and team notifications. */
@Injectable()
export class DocsNotifyTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
    private readonly runner: AgentTaskRunner,
    private readonly knowledge: KnowledgeService,
    private readonly notifications: NotificationsService,
  ) {}

  async generateDocs(input: { topic: string; ticketKey?: string | null; codeGenerationId?: string | null; specArtifactId?: string | null; context?: string | null; publish: boolean; title?: string | null }, ctx: ToolExecutionContext) {
    const parts: string[] = [];
    if (input.specArtifactId) {
      const spec = await this.prisma.artifact.findFirst({ where: { id: input.specArtifactId, organizationId: ctx.organizationId } });
      if (spec) parts.push(`## Specification\n${spec.content}`);
    }
    if (input.codeGenerationId) {
      const cg = await this.prisma.codeGeneration.findFirst({ where: { id: input.codeGenerationId, organizationId: ctx.organizationId } });
      if (cg) parts.push(`## Implemented change\nRequirement: ${cg.requirement}\nBranch: ${cg.branch}\n\n${(cg.diff ?? '').slice(0, 30_000)}`);
    }
    const retrieved = input.context ? { context: input.context } : await this.knowledge.retrieve({ organizationId: ctx.organizationId, projectId: ctx.project?.id, query: input.topic, k: 10 });
    parts.push(`## Knowledge\n${retrieved.context}`);
    const { output } = await this.runner.structured({
      ctx,
      agent: 'docs',
      task: `Write documentation: ${input.topic}`,
      prompt: 'docsGenerate',
      variables: { topic: input.topic, project: ctx.project?.name ?? 'Unknown', context: forPrompt(parts.join('\n\n'), 80_000) },
      schema: documentDraftSchema,
      schemaName: 'document_draft',
      role: 'planner',
      summarize: (d) => `${d.type}: ${d.title}`,
    });
    const title = input.title ?? (input.ticketKey ? `${output.title} (${input.ticketKey})` : output.title);
    const doc = await this.prisma.document.create({
      data: { organizationId: ctx.organizationId, projectId: ctx.project?.id ?? null, executionId: ctx.executionId ?? null, title, type: output.type, content: output.markdown, createdById: ctx.userId },
    });
    let notionUrl: string | null = null;
    let publishNote = 'Saved in Forgeline';
    if (input.publish) {
      const connected = await ctx.clients.connected();
      if (!connected.includes('NOTION')) publishNote = 'Saved in Forgeline (Notion not connected)';
      else if (!ctx.project?.settings.notionParentPageId) publishNote = 'Saved in Forgeline (no Notion parent page configured)';
      else {
        const res = await this.registry.get('notion.createPage')!.execute({ title, markdown: output.markdown, icon: '📘' }, ctx);
        const o = res.output as { pageId: string; url: string };
        notionUrl = o.url;
        publishNote = 'Published to Notion';
        await this.prisma.document.update({ where: { id: doc.id }, data: { externalProvider: 'NOTION', externalId: o.pageId, externalUrl: o.url } });
      }
    }
    await this.knowledge
      .ingestText({ organizationId: ctx.organizationId, projectId: ctx.project?.id, userId: ctx.userId, sourceType: 'SPECIFICATION', sourceRef: `document:${doc.id}`, title, content: output.markdown, documentType: output.type.toLowerCase(), url: notionUrl })
      .catch(() => undefined);
    return {
      output: { documentId: doc.id, title, type: output.type, notionUrl, published: Boolean(notionUrl) },
      summary: `${publishNote}: "${title}"`,
      artifacts: [{ type: 'DOCUMENTATION' as const, title, content: output.markdown, url: notionUrl ?? undefined }],
      externalResources: notionUrl ? [{ provider: 'NOTION' as const, type: 'NOTION_PAGE' as const, externalId: (await this.prisma.document.findUniqueOrThrow({ where: { id: doc.id } })).externalId!, title, url: notionUrl }] : [],
    };
  }

  onModuleInit(): void {
    const self = this;
    this.registry.register(
      defineLooseTool({
        name: 'docs.generate',
        title: 'Generate documentation',
        description: 'Write Markdown documentation from specs, code changes and knowledge; optionally publish to Notion.',
        category: 'notion',
        provider: null,
        agent: 'docs',
        inputSchema: z.object({
          topic: z.string().min(2).max(500),
          title: z.string().max(200).nullable().optional(),
          ticketKey: z.string().nullable().optional(),
          codeGenerationId: z.string().uuid().nullable().optional(),
          specArtifactId: z.string().uuid().nullable().optional(),
          context: z.string().max(80_000).nullable().optional(),
          publish: z.boolean().default(true),
        }),
        permission: 'docs:write',
        risk: 'write',
        sideEffects: true,
        approvalAction: 'docs.publish',
        defaultTimeoutMs: 600_000,
        execute: (input, ctx) => self.generateDocs(input, ctx),
        async simulate(input, ctx) {
          const doc = await self.prisma.document.create({ data: { organizationId: ctx.organizationId, projectId: ctx.project?.id ?? null, executionId: ctx.executionId ?? null, title: `${input.topic} (demo)`, type: 'GUIDE', content: `# ${input.topic}\n\n> Simulated documentation (demo mode).`, createdById: ctx.userId } });
          return { simulated: true, output: { documentId: doc.id, title: doc.title, type: 'GUIDE', notionUrl: null, published: false }, summary: `[Simulated] Published "${doc.title}" to Notion` };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'notify.team',
        title: 'Notify team',
        description: 'Notify project members in-app and post to Slack when connected.',
        category: 'notification',
        provider: null,
        agent: 'release',
        inputSchema: z.object({ title: z.string().min(1).max(200), message: z.string().min(1).max(4000), link: z.string().max(500).nullable().optional(), level: z.enum(['info', 'success', 'warning', 'error']).default('info') }),
        permission: 'notify:send',
        risk: 'write',
        sideEffects: true,
        approvalAction: 'notify.team',
        async execute(input, ctx) {
          const inApp = await self.notifications.notifyProject(ctx.organizationId, ctx.project?.id ?? null, { type: 'SYSTEM', title: input.title, body: input.message, link: input.link ?? null });
          let slack = false;
          if ((await ctx.clients.connected()).includes('SLACK')) {
            await self.registry.get('slack.postMessage')!.execute({ title: input.title, text: input.message, ...(input.link && /^https?:\/\//.test(input.link) ? { link: input.link } : {}) }, ctx);
            slack = true;
          }
          return { output: { inApp, slack }, summary: `Notified ${inApp} member(s) in-app${slack ? ' and posted to Slack' : ' (Slack not connected)'}` };
        },
        async simulate(input, ctx) {
          const inApp = await self.notifications.notifyProject(ctx.organizationId, ctx.project?.id ?? null, { type: 'SYSTEM', title: input.title, body: `${input.message}\n\n(Demo workspace — simulated run)`, link: input.link ?? null });
          return { simulated: true, output: { inApp, slack: false }, summary: `Notified ${inApp} member(s) in-app ([Simulated] Slack)` };
        },
      }),
    );
  }
}

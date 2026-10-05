import { Body, Controller, Get, Inject, Injectable, Module, Param, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiProperty, ApiPropertyOptional, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { commandRouteSchema, invokeStructured, renderPrompt, UsageTracker, type CommandRoute, type LlmProvider } from '@forgeline/ai';
import { COMMANDS, deployPermissionFor, findCommand, TRIGGER_SOURCES, type PageContext, type TriggerSource } from '@forgeline/shared';
import { CurrentAuth, RequirePermissions, type AuthContext } from '../common/auth/auth-context';
import { AppException } from '../common/errors';
import { PrismaService } from '../common/prisma/prisma.service';
import { AuthorizationService } from '../rbac/authorization.service';
import { ExecutionsService } from '../workflow-execution/executions.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { findTemplate } from '../workflows/flow-templates';
import { PlannerService } from '../agents/planner.service';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';

const PAGES: { route: string; title: string; keywords: string[] }[] = [
  { route: '/dashboard', title: 'Command Center', keywords: ['dashboard', 'home', 'command center', 'overview'] },
  { route: '/chat', title: 'Chat with Forge', keywords: ['chat', 'assistant', 'ask'] },
  { route: '/projects', title: 'Projects', keywords: ['projects'] },
  { route: '/workflows', title: 'Flows', keywords: ['flows', 'workflows', 'templates', 'builder'] },
  { route: '/executions', title: 'Runs', keywords: ['runs', 'executions', 'history'] },
  { route: '/approvals', title: 'Approvals', keywords: ['approvals', 'gates', 'pending'] },
  { route: '/deployments', title: 'Deployments', keywords: ['deployments', 'releases', 'environments'] },
  { route: '/qa', title: 'QA', keywords: ['qa', 'tests', 'quality'] },
  { route: '/code-reviews', title: 'Code reviews', keywords: ['reviews', 'code review'] },
  { route: '/graph', title: 'Engineering Graph', keywords: ['graph', 'relationships', 'map'] },
  { route: '/knowledge', title: 'Knowledge', keywords: ['knowledge', 'docs index', 'rag', 'search'] },
  { route: '/integrations', title: 'Integrations', keywords: ['integrations', 'connect', 'github', 'jira', 'notion', 'trello', 'slack'] },
  { route: '/agents', title: 'Agents', keywords: ['agents', 'ai'] },
  { route: '/tasks', title: 'Tasks', keywords: ['tasks', 'tickets'] },
  { route: '/documents', title: 'Documents', keywords: ['documents', 'documentation'] },
  { route: '/audit-logs', title: 'Audit log', keywords: ['audit', 'logs', 'security'] },
  { route: '/observability', title: 'Observability', keywords: ['observability', 'metrics', 'usage', 'tokens'] },
  { route: '/settings', title: 'Settings', keywords: ['settings', 'team', 'members', 'policy'] },
];

/**
 * Command bus: the same business actions are reachable from chat, the command
 * palette, page buttons, webhooks and schedules. Each command maps to a Flow
 * template and is permission-checked here and again at every tool call.
 */
@Injectable()
export class CommandsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly authz: AuthorizationService,
    private readonly executions: ExecutionsService,
    private readonly workflows: WorkflowsService,
    private readonly planner: PlannerService,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  catalog() {
    return { commands: COMMANDS, pages: PAGES };
  }

  async execute(
    auth: AuthContext,
    commandId: string,
    params: { projectId?: string | null; inputs?: Record<string, unknown>; source?: TriggerSource; idempotencyKey?: string },
  ) {
    const command = findCommand(commandId);
    if (!command) throw AppException.notFound('Command', commandId);
    const projectId = params.projectId ?? (typeof params.inputs?.projectId === 'string' ? params.inputs.projectId : null);
    if (command.inputs.some((i) => i.type === 'project') && !projectId)
      throw AppException.badRequest('A project is required for this command', 'PROJECT_REQUIRED');
    const inputs = { ...(params.inputs ?? {}) };
    delete inputs.projectId;
    let permission = command.permission;
    if (command.id.startsWith('deploy.') && typeof inputs.environment === 'string' && projectId) {
      const env = await this.prisma.environment.findFirst({
        where: { projectId, name: inputs.environment, organizationId: auth.organizationId },
      });
      if (!env) throw AppException.badRequest(`Unknown environment "${inputs.environment}"`, 'UNKNOWN_ENVIRONMENT');
      permission = deployPermissionFor(env.type);
    }
    await this.authz.assertPermission(auth, permission, projectId);
    for (const spec of command.inputs.filter((i) => i.required && i.type !== 'project')) {
      if (inputs[spec.name] === undefined || inputs[spec.name] === '')
        throw AppException.badRequest(`"${spec.label}" is required`, 'INPUT_REQUIRED');
    }
    const template = findTemplate(command.template)!;
    const subject = String(
      inputs.requirement ?? inputs.topic ?? inputs.message ?? inputs.environment ?? (inputs.pullNumber ? `PR #${inputs.pullNumber}` : ''),
    ).slice(0, 80);
    return this.executions.start({
      organizationId: auth.organizationId,
      projectId,
      userId: auth.userId,
      title: subject ? `${command.title}: ${subject}` : command.title,
      definition: this.workflows.templateDefinition(template.key),
      input: inputs,
      template: template.key,
      triggerSource: params.source ?? 'COMMAND_PALETTE',
      idempotencyKey: params.idempotencyKey,
    });
  }

  /** Natural-language command palette routing ("deploy auth service to staging"). */
  async route(
    auth: AuthContext,
    query: string,
    pageContext?: PageContext,
  ): Promise<CommandRoute & { projectId: string | null; source: 'ai' | 'keyword' }> {
    const projects = await this.prisma.project.findMany({
      where: { organizationId: auth.organizationId, deletedAt: null },
      select: { id: true, name: true, key: true, environments: { select: { name: true } } },
    });
    const lower = query.toLowerCase();
    const mentioned = projects.find(
      (p) =>
        lower.includes(p.name.toLowerCase()) ||
        lower.includes(p.key.toLowerCase()) ||
        p.name
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.length > 3 && lower.includes(w)),
    );
    const projectId = mentioned?.id ?? pageContext?.projectId ?? null;
    if (this.llm.isConfigured()) {
      try {
        const usage = new UsageTracker();
        const messages = await renderPrompt('commandRoute', {
          commands: COMMANDS.map((c) => `- ${c.id}: ${c.title} — inputs: ${c.inputs.map((i) => i.name).join(', ')}`).join('\n'),
          pages: PAGES.map((p) => `- ${p.route}: ${p.title}`).join('\n'),
          projects: projects.map((p) => `- ${p.name} (${p.key}) envs: ${p.environments.map((e) => e.name).join(', ')}`).join('\n'),
          query,
        });
        const r = await invokeStructured({
          model: this.llm.chatModel('fast'),
          schema: commandRouteSchema,
          name: 'command_route',
          messages,
          usage,
          modelName: this.llm.modelName('fast'),
        });
        if (r.kind !== 'command' || (r.commandId && findCommand(r.commandId))) return { ...r, projectId, source: 'ai' };
      } catch {
        /* fall through to keyword routing */
      }
    }
    const page = PAGES.find((p) => p.keywords.some((k) => lower === k || lower === `go to ${k}` || lower === `open ${k}`));
    if (page)
      return {
        kind: 'navigate',
        commandId: null,
        route: page.route,
        inputs: [],
        confidence: 0.8,
        explanation: `Open ${page.title}`,
        projectId,
        source: 'keyword',
      };
    const { template, score } = this.planner.heuristicTemplate(query);
    const command = COMMANDS.find((c) => c.template === template);
    if (!command || score === 0)
      return {
        kind: 'chat',
        commandId: null,
        route: null,
        inputs: [{ name: 'message', value: query }],
        confidence: 0.3,
        explanation: 'Ask Forge in chat',
        projectId,
        source: 'keyword',
      };
    const env =
      mentioned?.environments.find((e) => lower.includes(e.name)) ??
      projects.flatMap((p) => p.environments).find((e) => lower.includes(e.name));
    const inputs = [
      ...(command.inputs.some((i) => i.name === 'requirement') ? [{ name: 'requirement', value: query }] : []),
      ...(command.inputs.some((i) => i.name === 'topic') ? [{ name: 'topic', value: query }] : []),
      ...(command.inputs.some((i) => i.name === 'message') ? [{ name: 'message', value: query }] : []),
      ...(env && command.inputs.some((i) => i.name === 'environment') ? [{ name: 'environment', value: env.name }] : []),
    ];
    return {
      kind: 'command',
      commandId: command.id,
      route: null,
      inputs,
      confidence: Math.min(0.9, 0.4 + score / 40),
      explanation: `${command.title}${mentioned ? ` · ${mentioned.name}` : ''}`,
      projectId,
      source: 'keyword',
    };
  }
}

class ExecuteCommandDto {
  @ApiPropertyOptional() @IsOptional() @IsUUID() projectId?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() inputs?: Record<string, unknown>;
  @ApiPropertyOptional({ enum: TRIGGER_SOURCES }) @IsOptional() @IsIn(TRIGGER_SOURCES) source?: TriggerSource;
  @ApiPropertyOptional() @IsOptional() @IsString() @MaxLength(200) idempotencyKey?: string;
}
class RouteDto {
  @ApiProperty() @IsString() @MinLength(2) @MaxLength(500) query!: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() pageContext?: PageContext;
}

@ApiTags('commands')
@ApiBearerAuth()
@Controller('commands')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  @Get()
  @RequirePermissions('workflow:read')
  catalog() {
    return this.commands.catalog();
  }

  @Post('route')
  @ApiOperation({ summary: 'Route natural-language palette input to a command, page or chat' })
  @RequirePermissions('workflow:read')
  route(@CurrentAuth() auth: AuthContext, @Body() dto: RouteDto) {
    return this.commands.route(auth, dto.query, dto.pageContext);
  }

  @Post(':id/execute')
  @ApiOperation({ summary: 'Execute a command (starts the mapped Flow)' })
  execute(@CurrentAuth() auth: AuthContext, @Param('id') id: string, @Body() dto: ExecuteCommandDto) {
    return this.commands.execute(auth, id, dto);
  }
}

@Module({
  controllers: [CommandsController],
  providers: [CommandsService],
  exports: [CommandsService],
})
export class CommandsModule {}

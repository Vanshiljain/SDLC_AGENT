import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { flowPlanSchema, TEMPLATE_SYNTAX_HELP, type LlmProvider } from '@forgeline/ai';
import { COMMANDS, type FlowProposalPart, type FlowProposalStep, type IntegrationProvider, type WorkflowDefinition, type WorkflowDefinitionInput } from '@forgeline/shared';
import { resolveTemplates, validateWorkflowDefinition } from '@forgeline/workflow-engine';
import { PrismaService } from '../common/prisma/prisma.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ApprovalPolicyService } from '../approvals/approval-policy.service';
import { ProjectContextService } from '../projects/projects.service';
import { ConnectionResolver } from '../integrations/connection-resolver.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { FLOW_TEMPLATES, findTemplate } from '../workflows/flow-templates';
import { LLM_PROVIDER } from '../knowledge/knowledge.tokens';
import { AgentTaskRunner, forPrompt } from '../sdlc/agent-task-runner.service';

export interface StoredProposal {
  id: string;
  title: string;
  summary: string;
  template: string | null;
  projectId: string | null;
  definition: WorkflowDefinition;
  input: Record<string, unknown>;
  createdAt: string;
  source: 'ai' | 'keyword';
}

export interface PlanResult {
  proposal: StoredProposal;
  part: FlowProposalPart;
}

/**
 * Planning agent: turns a request into a validated Flow (template + inputs, or
 * a custom DAG over registered tools), then annotates which steps will hit
 * approval gates and which integrations are missing. The policy engine — not
 * the model — decides approvals.
 */
@Injectable()
export class PlannerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ToolRegistry,
    private readonly policy: ApprovalPolicyService,
    private readonly projects: ProjectContextService,
    private readonly connections: ConnectionResolver,
    private readonly workflows: WorkflowsService,
    private readonly tasks: AgentTaskRunner,
    @Inject(LLM_PROVIDER) private readonly llm: LlmProvider,
  ) {}

  /** Keyword routing used when no LLM is configured (clearly labelled as such). */
  heuristicTemplate(request: string): { template: string; score: number } {
    const text = request.toLowerCase();
    let best = { template: 'feature_delivery', score: 0 };
    for (const c of COMMANDS) {
      const score = c.keywords.reduce((s, k) => s + (text.includes(k) ? k.length : 0), 0);
      if (score > best.score) best = { template: c.template, score };
    }
    return best;
  }

  async plan(params: { organizationId: string; userId: string; projectId: string | null; request: string; context?: string; executionContext?: { executionId?: string | null } }): Promise<PlanResult> {
    const project = await this.projects.load(params.organizationId, params.projectId);
    let title: string;
    let summary: string;
    let template: string | null;
    let input: Record<string, unknown>;
    let definition: WorkflowDefinition;
    let source: StoredProposal['source'] = 'ai';

    if (this.llm.isConfigured()) {
      const templates = FLOW_TEMPLATES.map((t) => {
        const inputs = Object.entries(this.workflows.templateDefinition(t.key).inputs).map(([k, v]) => `${k}${v.required ? '' : '?'}:${v.type}`).join(', ');
        return `- ${t.key}: ${t.name} — ${t.description} Inputs: {${inputs}}`;
      }).join('\n');
      const { output } = await this.tasks.structured({
        ctx: { organizationId: params.organizationId, userId: params.userId, executionId: params.executionContext?.executionId ?? null, signal: new AbortController().signal, logger: { debug() {}, info() {}, warn() {}, error() {} } },
        agent: 'planning',
        task: 'Plan flow',
        prompt: 'planFlow',
        variables: {
          templates,
          tools: this.registry.promptCatalog(),
          templateSyntax: TEMPLATE_SYNTAX_HELP,
          project: project ? `${project.name} (${project.key}); repository: ${project.repository?.fullName ?? 'none'}; environments: ${project.environments.map((e) => `${e.name}:${e.type}`).join(', ')}` : 'No project selected',
          context: forPrompt(params.context, 8000),
          request: params.request,
        },
        schema: flowPlanSchema,
        schemaName: 'flow_plan',
        role: 'planner',
        summarize: (p) => `${p.template ?? 'custom'}: ${p.title}`,
      });
      title = output.title;
      summary = output.summary;
      template = output.template && findTemplate(output.template) ? output.template : null;
      input = Object.fromEntries(output.inputs.map((i) => [i.name, i.value]));
      if (template) {
        definition = this.workflows.templateDefinition(template);
      } else {
        const custom: WorkflowDefinitionInput = {
          steps: output.customSteps.map((s) => {
            let stepInput: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(s.inputJson || '{}') as unknown;
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) stepInput = parsed as Record<string, unknown>;
            } catch {
              stepInput = {};
            }
            return { key: s.key, name: s.name, tool: s.tool, dependsOn: s.dependsOn, input: stepInput, ...(s.when && { when: s.when }) };
          }),
        };
        const res = validateWorkflowDefinition(custom, { toolExists: (t) => this.registry.has(t) });
        if (!res.valid) {
          // Fall back to the closest template rather than executing an invalid plan.
          template = this.heuristicTemplate(params.request).template;
          definition = this.workflows.templateDefinition(template);
          summary = `${summary} (custom plan was invalid: ${res.issues.slice(0, 2).map((i) => i.message).join('; ')} — using the "${findTemplate(template)?.name}" flow instead)`;
        } else {
          definition = res.definition;
        }
      }
    } else {
      source = 'keyword';
      template = this.heuristicTemplate(params.request).template;
      const t = findTemplate(template)!;
      definition = this.workflows.templateDefinition(template);
      title = `${t.name}: ${params.request.slice(0, 60)}`;
      summary = `${t.description} (AI provider not configured — matched by keywords)`;
      input = {};
    }

    // Map the natural-language request onto the template's free-text inputs.
    for (const key of ['requirement', 'topic', 'message']) {
      if (definition.inputs[key] && (input[key] === undefined || input[key] === '')) input[key] = params.request;
    }
    if (definition.inputs.environment && !input.environment) {
      const env = project?.environments.find((e) => params.request.toLowerCase().includes(e.name.toLowerCase()));
      if (env) input.environment = env.name;
    }

    const proposal: StoredProposal = { id: randomUUID(), title, summary, template, projectId: params.projectId, definition, input, createdAt: new Date().toISOString(), source };
    return { proposal, part: await this.describe(params.organizationId, proposal) };
  }

  /** Annotate a proposal with policy gates and missing integrations for the UI card. */
  async describe(organizationId: string, proposal: StoredProposal): Promise<FlowProposalPart> {
    const project = await this.projects.load(organizationId, proposal.projectId);
    const connected = new Set<IntegrationProvider>(await this.connections.connectedProviders(organizationId));
    const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { isDemo: true } });
    const missing = new Set<string>();
    const approvals: string[] = [];
    const steps: FlowProposalStep[] = [];
    const withDefaults: Record<string, unknown> = { ...Object.fromEntries(Object.entries(proposal.definition.inputs).map(([k, v]) => [k, v.default])), ...proposal.input };
    for (const s of proposal.definition.steps) {
      const tool = s.tool ? this.registry.get(s.tool) : undefined;
      let requiresApproval = s.type === 'approval';
      if (tool) {
        const action = this.policy.actionFor(tool, s.input);
        if (action) {
          let resolved: Record<string, unknown> = {};
          try {
            resolved = resolveTemplates(s.input, { inputs: withDefaults, variables: proposal.definition.variables, steps: {} });
          } catch {
            resolved = {};
          }
          const envName = typeof resolved.environment === 'string' && resolved.environment ? resolved.environment : null;
          const decision = await this.policy.evaluate(organizationId, project, action, envName);
          requiresApproval = decision.required;
          if (decision.required) approvals.push(`${s.name} (${decision.action})`);
        }
        const provider = tool.provider;
        if (provider && !org.isDemo) {
          const satisfied = provider === 'CUSTOM_DEVOPS' ? connected.has('CUSTOM_DEVOPS') || connected.has('GITHUB_ACTIONS') || connected.has('GITHUB') : provider === 'GITHUB_ACTIONS' ? connected.has('GITHUB_ACTIONS') || connected.has('GITHUB') : connected.has(provider);
          if (!satisfied) missing.add(provider);
        }
      }
      if (s.type === 'approval') approvals.push(s.approval?.title ?? s.name);
      steps.push({ key: s.key, name: s.name, tool: s.tool, type: s.type, dependsOn: s.dependsOn, requiresApproval, agent: s.agent ?? tool?.agent });
    }
    return {
      type: 'flow_proposal',
      proposalId: proposal.id,
      title: proposal.title,
      summary: proposal.summary,
      projectId: proposal.projectId,
      steps,
      approvalsRequired: approvals,
      missingIntegrations: [...missing],
      state: 'proposed',
      mode: org.isDemo ? 'DEMO' : 'LIVE',
    };
  }
}

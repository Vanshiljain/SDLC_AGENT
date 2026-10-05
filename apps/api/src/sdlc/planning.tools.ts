import { Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import { implementationPlanSchema, pullRequestDescriptionSchema, technicalSpecSchema, ticketDraftSchema, type ImplementationPlan, type TechnicalSpec } from '@forgeline/ai';
import { defineLooseTool } from '@forgeline/integrations';
import { ToolError } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { AgentTaskRunner, forPrompt } from './agent-task-runner.service';

export function specToMarkdown(s: TechnicalSpec): string {
  const list = (items: string[]) => (items.length ? items.map((i) => `- ${i}`).join('\n') : '_None_');
  return [
    `# ${s.title}`,
    s.summary,
    `## Problem\n${s.problem}`,
    `## Goals\n${list(s.goals)}`,
    `## Non-goals\n${list(s.nonGoals)}`,
    `## Approach\n${s.approach}`,
    s.components.length ? `## Components\n| Component | Responsibility | Changes |\n|---|---|---|\n${s.components.map((c) => `| ${c.name} | ${c.responsibility} | ${c.changes} |`).join('\n')}` : '',
    s.apiChanges.length ? `## API changes\n${s.apiChanges.map((a) => `- \`${a.method} ${a.path}\` — ${a.description}`).join('\n')}` : '',
    s.dataModelChanges.length ? `## Data model\n${s.dataModelChanges.map((d) => `- **${d.entity}**: ${d.change}`).join('\n')}` : '',
    `## Security\n${list(s.security)}`,
    `## Testing\n${list(s.testing)}`,
    s.risks.length ? `## Risks\n${s.risks.map((r) => `- **${r.risk}** — ${r.mitigation}`).join('\n')}` : '',
    `## Open questions\n${list(s.openQuestions)}`,
    `## Rollout\n${s.rollout}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function planToMarkdown(p: ImplementationPlan): string {
  return [
    `# Implementation plan`,
    p.summary,
    `**Branch:** \`${p.branchName}\` · **Complexity:** ${p.complexity}`,
    `## Affected files\n${p.affectedFiles.map((f) => `- \`${f.path}\` (${f.action}) — ${f.reason}`).join('\n')}`,
    `## Steps\n${p.steps.map((s, i) => `${i + 1}. **${s.title}** — ${s.detail}${s.files.length ? ` (${s.files.map((f) => `\`${f}\``).join(', ')})` : ''}`).join('\n')}`,
    `## Test plan\n${p.testPlan.map((t) => `- ${t}`).join('\n')}`,
    p.risks.length ? `## Risks\n${p.risks.map((r) => `- ${r}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function sanitizeBranch(name: string, ticketKey?: string | null): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9/._-]+/g, '-')
    .replace(/\/{2,}/g, '/')
    .replace(/(^[-/.]+|[-/.]+$)/g, '')
    .replace(/\.\.+/g, '.')
    .slice(0, 80);
  const withPrefix = base.includes('/') ? base : `feature/${base}`;
  if (ticketKey && !withPrefix.toLowerCase().includes(ticketKey.toLowerCase())) {
    const [prefix, ...rest] = withPrefix.split('/');
    return `${prefix}/${ticketKey.toLowerCase()}-${rest.join('/')}`.slice(0, 100);
  }
  return withPrefix || 'feature/forgeline-change';
}

const repoSummary = (repo: unknown) => {
  if (!repo || typeof repo !== 'object') return '(repository not analysed)';
  const r = repo as { fileCount?: number; frameworks?: string[]; languages?: unknown; scripts?: unknown; manifests?: string[]; topLevel?: string[]; sampleFiles?: string[] };
  return forPrompt({ fileCount: r.fileCount, frameworks: r.frameworks, languages: r.languages, scripts: r.scripts, manifests: r.manifests, topLevel: r.topLevel }, 4000);
};

@Injectable()
export class PlanningTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly runner: AgentTaskRunner,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    const runner = this.runner;
    const prisma = this.prisma;

    this.registry.register(
      defineLooseTool({
        name: 'ai.draftTicket',
        title: 'Draft ticket',
        description: 'Draft a ticket (summary, description, acceptance criteria, priority) from a requirement and project context.',
        category: 'ai',
        provider: null,
        agent: 'planning',
        inputSchema: z.object({ requirement: z.string().min(3).max(20_000), context: z.string().max(40_000).optional() }),
        permission: 'agent:use',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 180_000,
        async execute(input, ctx) {
          const { output } = await runner.structured({
            ctx,
            agent: 'planning',
            task: 'Draft ticket',
            prompt: 'ticketDraft',
            variables: { project: ctx.project ? `${ctx.project.name} (${ctx.project.key})` : 'Unknown', context: forPrompt(input.context), requirement: input.requirement },
            schema: ticketDraftSchema,
            schemaName: 'ticket_draft',
            role: 'planner',
            summarize: (t) => `${t.issueType}: ${t.summary} (${t.acceptanceCriteria.length} acceptance criteria)`,
          });
          const description = `${output.description}\n\n## Acceptance criteria\n${output.acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`;
          return {
            output: { ...output, description },
            summary: `Drafted ${output.issueType.toLowerCase()} "${output.summary}"`,
            artifacts: [{ type: 'TICKET', title: output.summary, content: `# ${output.summary}\n\n${description}`, data: output }],
          };
        },
        async simulate(input) {
          const summary = `Implement ${input.requirement.replace(/^implement\s+/i, '').slice(0, 80)}`;
          const acceptanceCriteria = ['Users can request a reset link by email', 'Reset tokens are single-use, hashed at rest and expire after 30 minutes', 'Passwords are validated against the password policy', 'All sessions are revoked after a successful reset'];
          const description = `## Context\nDemo ticket generated in simulation mode.\n\n## Acceptance criteria\n${acceptanceCriteria.map((c) => `- [ ] ${c}`).join('\n')}`;
          return { simulated: true, output: { summary, issueType: 'Story' as const, priority: 'High' as const, description, acceptanceCriteria, labels: ['auth'] }, summary: `[Simulated] Drafted story "${summary}"`, artifacts: [{ type: 'TICKET', title: summary, content: description }] };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'ai.generateSpec',
        title: 'Generate technical specification',
        description: 'Write a technical specification grounded in the repository analysis and retrieved knowledge.',
        category: 'ai',
        provider: null,
        agent: 'architect',
        inputSchema: z.object({
          requirement: z.string().min(3).max(20_000),
          ticket: z.unknown().optional(),
          repository: z.unknown().optional(),
          context: z.string().max(40_000).optional(),
        }),
        permission: 'agent:use',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 300_000,
        async execute(input, ctx) {
          const { output } = await runner.structured({
            ctx,
            agent: 'architect',
            task: 'Generate technical specification',
            prompt: 'technicalSpec',
            variables: {
              project: ctx.project ? `${ctx.project.name} — ${ctx.project.description ?? ''}` : 'Unknown',
              repository: repoSummary(input.repository),
              context: forPrompt(input.context),
              requirement: input.ticket ? `${input.requirement}\n\nTicket:\n${forPrompt(input.ticket, 8000)}` : input.requirement,
            },
            schema: technicalSpecSchema,
            schemaName: 'technical_spec',
            role: 'planner',
            summarize: (s) => `${s.components.length} components, ${s.apiChanges.length} API changes, ${s.risks.length} risks`,
          });
          const markdown = specToMarkdown(output);
          const artifact = ctx.executionId
            ? await prisma.artifact.create({ data: { organizationId: ctx.organizationId, projectId: ctx.project?.id, executionId: ctx.executionId, type: 'SPECIFICATION', title: output.title, content: markdown, data: output as object, createdById: ctx.userId } })
            : null;
          return { output: { ...output, markdown, artifactId: artifact?.id ?? null }, summary: `Specification "${output.title}" (${output.components.length} components)` };
        },
        async simulate(input, ctx) {
          const spec: TechnicalSpec = {
            title: `Technical specification: ${input.requirement.slice(0, 60)}`,
            summary: 'Demo specification generated in simulation mode.',
            problem: 'Users who forget their password cannot regain access without support involvement.',
            goals: ['Self-service password reset via email', 'Secure single-use tokens'],
            nonGoals: ['SMS-based recovery'],
            approach: 'Add `POST /auth/password-reset/request` and `POST /auth/password-reset/confirm` to the existing AuthController, store SHA-256 hashed tokens with 30-minute expiry in a new `PasswordResetToken` table, and revoke refresh tokens on success.',
            components: [{ name: 'AuthService', responsibility: 'Token issuance and verification', changes: 'Add request/confirm methods' }],
            apiChanges: [{ method: 'POST', path: '/auth/password-reset/request', description: 'Send reset email' }, { method: 'POST', path: '/auth/password-reset/confirm', description: 'Set new password' }],
            dataModelChanges: [{ entity: 'PasswordResetToken', change: 'New table (userId, tokenHash, expiresAt, usedAt)' }],
            security: ['Constant-time responses to prevent account enumeration', 'Rate limit reset requests'],
            testing: ['Unit tests for token lifecycle', 'API tests for both endpoints'],
            risks: [{ risk: 'Email deliverability', mitigation: 'Monitor bounce rate' }],
            openQuestions: [],
            rollout: 'Ship behind a feature flag to staging first.',
          };
          const markdown = specToMarkdown(spec);
          const artifact = ctx.executionId ? await prisma.artifact.create({ data: { organizationId: ctx.organizationId, projectId: ctx.project?.id, executionId: ctx.executionId, type: 'SPECIFICATION', title: spec.title, content: `> Simulated (demo mode)\n\n${markdown}`, createdById: ctx.userId } }) : null;
          return { simulated: true, output: { ...spec, markdown, artifactId: artifact?.id ?? null }, summary: '[Simulated] Specification with 1 component, 2 API changes' };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'ai.generatePlan',
        title: 'Generate implementation plan',
        description: 'Identify affected files and produce an ordered implementation plan, branch name and test plan.',
        category: 'ai',
        provider: null,
        agent: 'planning',
        inputSchema: z.object({
          requirement: z.string().min(3).max(20_000),
          ticketKey: z.string().max(40).nullable().optional(),
          spec: z.string().max(60_000).optional(),
          repository: z.unknown().optional(),
          context: z.string().max(40_000).optional(),
        }),
        permission: 'agent:use',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 300_000,
        async execute(input, ctx) {
          const repo = input.repository as { sampleFiles?: string[] } | undefined;
          const { output } = await runner.structured({
            ctx,
            agent: 'planning',
            task: 'Generate implementation plan',
            prompt: 'implementationPlan',
            variables: {
              project: ctx.project?.name ?? 'Unknown',
              files: forPrompt((repo?.sampleFiles ?? []).join('\n'), 12_000),
              spec: forPrompt(input.spec, 20_000),
              context: forPrompt(input.context),
              requirement: input.requirement,
            },
            schema: implementationPlanSchema,
            schemaName: 'implementation_plan',
            role: 'planner',
            summarize: (p) => `${p.affectedFiles.length} files, ${p.steps.length} steps, ${p.complexity} complexity`,
          });
          const plan = { ...output, branchName: sanitizeBranch(output.branchName, input.ticketKey ?? undefined) };
          const markdown = planToMarkdown(plan);
          const artifact = ctx.executionId
            ? await prisma.artifact.create({ data: { organizationId: ctx.organizationId, projectId: ctx.project?.id, executionId: ctx.executionId, type: 'IMPLEMENTATION_PLAN', title: `Implementation plan · ${plan.branchName}`, content: markdown, data: plan as object, createdById: ctx.userId } })
            : null;
          return { output: { ...plan, markdown, artifactId: artifact?.id ?? null }, summary: `Plan: ${plan.affectedFiles.length} files across ${plan.steps.length} steps on ${plan.branchName}` };
        },
        async simulate(input, ctx) {
          const plan: ImplementationPlan = {
            summary: 'Demo plan generated in simulation mode.',
            branchName: sanitizeBranch(`feature/${input.requirement.slice(0, 40)}`, input.ticketKey ?? undefined),
            complexity: 'medium',
            affectedFiles: [
              { path: 'src/auth/password-reset.service.ts', action: 'create', reason: 'Token lifecycle' },
              { path: 'src/auth/auth.controller.ts', action: 'modify', reason: 'New endpoints' },
              { path: 'src/auth/password-reset.service.spec.ts', action: 'create', reason: 'Unit tests' },
            ],
            steps: [{ title: 'Add token model', detail: 'Prisma model + migration', files: ['prisma/schema.prisma'] }, { title: 'Implement service and endpoints', detail: 'Request + confirm flows', files: ['src/auth/password-reset.service.ts'] }],
            testPlan: ['Token expiry', 'Single use', 'Enumeration-safe responses'],
            risks: ['Email provider limits'],
          };
          const artifact = ctx.executionId ? await prisma.artifact.create({ data: { organizationId: ctx.organizationId, projectId: ctx.project?.id, executionId: ctx.executionId, type: 'IMPLEMENTATION_PLAN', title: `Implementation plan · ${plan.branchName}`, content: `> Simulated (demo mode)\n\n${planToMarkdown(plan)}`, createdById: ctx.userId } }) : null;
          return { simulated: true, output: { ...plan, markdown: planToMarkdown(plan), artifactId: artifact?.id ?? null }, summary: `[Simulated] Plan: 3 files on ${plan.branchName}` };
        },
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'ai.describePullRequest',
        title: 'Write PR description',
        description: 'Write a pull request title and description from the plan, changes and validation results.',
        category: 'ai',
        provider: null,
        agent: 'code',
        inputSchema: z.object({ codeGenerationId: z.string().uuid(), ticketKey: z.string().nullable().optional(), ticketUrl: z.string().nullable().optional() }),
        permission: 'agent:use',
        risk: 'read',
        sideEffects: false,
        defaultTimeoutMs: 120_000,
        async execute(input, ctx) {
          const cg = await prisma.codeGeneration.findFirst({ where: { id: input.codeGenerationId, organizationId: ctx.organizationId } });
          if (!cg) throw new ToolError('not_found', 'Code generation not found', { retryable: false });
          const { output } = await runner.structured({
            ctx,
            agent: 'code',
            task: 'Write pull request description',
            prompt: 'prDescription',
            variables: {
              ticket: input.ticketKey ? `${input.ticketKey}${input.ticketUrl ? ` (${input.ticketUrl})` : ''}` : 'none',
              plan: forPrompt(cg.plan, 8000),
              files: forPrompt(cg.files, 6000),
              validation: forPrompt(cg.validation, 4000),
            },
            schema: pullRequestDescriptionSchema,
            schemaName: 'pull_request_description',
            role: 'fast',
            summarize: (d) => d.title,
          });
          const title = input.ticketKey && !output.title.includes(input.ticketKey) ? `${output.title} (${input.ticketKey})` : output.title;
          const body = `${output.body}\n\n---\n_Generated and validated by Forgeline. Sandbox validation: ${(cg.validation as { summary?: string } | null)?.summary ?? 'not run'}._`;
          return { output: { title: title.slice(0, 250), body }, summary: `PR title: ${title}`, artifacts: [{ type: 'PR_SUMMARY', title, content: body }] };
        },
        async simulate(input) {
          const title = `feat(auth): password reset${input.ticketKey ? ` (${input.ticketKey})` : ''}`;
          return { simulated: true, output: { title, body: '## Summary\nDemo pull request description (simulated).' }, summary: `[Simulated] PR title: ${title}` };
        },
      }),
    );
  }
}

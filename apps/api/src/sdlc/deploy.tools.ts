import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { z } from 'zod';
import type { Deployment, Prisma } from '@forgeline/database';
import {
  defineLooseTool,
  isTerminalRunStatus,
  runProbes,
  type ProbeResult,
  type ProjectEnvironmentContext,
  type ToolExecutionContext,
} from '@forgeline/integrations';
import { deployPermissionFor, ToolError } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { EventBus } from '../events/event-bus.service';
import { ToolRegistry } from '../tools/tool-registry.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

function envFor(ctx: ToolExecutionContext, name: string): ProjectEnvironmentContext {
  const env = ctx.project?.environments.find((e) => e.name === name);
  if (!env) throw new ToolError('not_found', `Environment "${name}" is not configured for this project`, { retryable: false });
  return env;
}

/**
 * Deployment automation. Deploy and rollback go through the provider-neutral
 * CiCdProvider; verification (health checks + smoke tests) is executed by
 * Forgeline itself against the environment URL, with automatic rollback.
 */
@Injectable()
export class DeployTools implements OnModuleInit {
  constructor(
    private readonly registry: ToolRegistry,
    private readonly prisma: PrismaService,
    private readonly events: EventBus,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private publish(
    ctx: ToolExecutionContext,
    type: 'deployment.started' | 'deployment.progress' | 'deployment.completed' | 'deployment.failed' | 'deployment.rolled_back',
    d: Deployment,
    environment: string,
    message?: string,
  ) {
    return this.events.publish({
      type,
      organizationId: ctx.organizationId,
      projectId: d.projectId,
      executionId: d.executionId,
      data: { deploymentId: d.id, environment, version: d.version, status: d.status, message: message ?? null, simulated: d.simulated },
    });
  }

  private async previousSuccessful(environmentId: string, excludeId?: string): Promise<Deployment | null> {
    return this.prisma.deployment.findFirst({
      where: { environmentId, status: 'SUCCEEDED', ...(excludeId && { id: { not: excludeId } }) },
      orderBy: { completedAt: 'desc' },
    });
  }

  async deploy(
    input: { environment: string; ref?: string | null; commitSha?: string | null; version?: string | null; artifactRef?: string | null },
    ctx: ToolExecutionContext,
  ) {
    const env = envFor(ctx, input.environment);
    const cp = ctx.checkpoint as { deploymentId: string; providerId: string } | undefined;
    const cicd = await ctx.clients.cicd();
    let deployment: Deployment;
    if (!cp) {
      const version =
        input.version ||
        `${(input.commitSha ?? input.ref ?? 'build').slice(0, 7)}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12)}`;
      const existing = ctx.executionId
        ? await this.prisma.deployment.findFirst({
            where: { executionId: ctx.executionId, environmentId: env.id, status: { in: ['IN_PROGRESS', 'VERIFYING', 'SUCCEEDED'] } },
          })
        : null;
      if (existing?.externalId && existing.status !== 'IN_PROGRESS') {
        return {
          output: {
            deploymentId: existing.id,
            status: existing.status,
            version: existing.version,
            url: existing.externalUrl,
            environment: env.name,
          },
          summary: `Deployment ${existing.version} to ${env.name} already ${existing.status.toLowerCase()}`,
        };
      }
      const previous = await this.previousSuccessful(env.id);
      deployment =
        existing ??
        (await this.prisma.deployment.create({
          data: {
            organizationId: ctx.organizationId,
            projectId: ctx.project!.id,
            environmentId: env.id,
            executionId: ctx.executionId ?? null,
            version,
            ref: input.ref ?? null,
            commitSha: input.commitSha ?? null,
            artifactRef: input.artifactRef ?? null,
            status: 'IN_PROGRESS',
            provider: cicd.name,
            previousDeploymentId: previous?.id ?? null,
            triggeredById: ctx.userId,
            startedAt: new Date(),
            changes: [] as Prisma.InputJsonValue,
          },
        }));
      const handle = await cicd.deploy({
        project: ctx.project!.slug,
        environment: env.name,
        environmentType: env.type,
        version: deployment.version,
        ref: input.ref ?? undefined,
        commitSha: input.commitSha ?? undefined,
        artifactRef: input.artifactRef ?? undefined,
        idempotencyKey: ctx.idempotencyKey,
        config: env.config,
      });
      deployment = await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { externalId: handle.id, externalUrl: handle.url ?? null },
      });
      await this.publish(ctx, 'deployment.started', deployment, env.name, `Deploying ${deployment.version} via ${cicd.name}`);
      ctx.logger.info(`Deployment ${handle.id} started on ${cicd.name}`);
      return {
        output: {
          deploymentId: deployment.id,
          status: 'IN_PROGRESS',
          version: deployment.version,
          url: handle.url ?? null,
          environment: env.name,
        },
        summary: `Deploying ${deployment.version} to ${env.name}`,
        continuation: {
          pollAfterMs: 5_000,
          checkpoint: { deploymentId: deployment.id, providerId: handle.id },
          message: `Deploying to ${env.name}`,
        },
        externalResources: [
          {
            provider: cicd.kind,
            type: 'DEPLOYMENT' as const,
            externalId: handle.id,
            key: deployment.version,
            title: `${env.name} · ${deployment.version}`,
            url: handle.url ?? undefined,
            status: 'in_progress',
          },
        ],
      };
    }
    deployment = await this.prisma.deployment.findUniqueOrThrow({ where: { id: cp.deploymentId } });
    const handle = await cicd.getDeployment(cp.providerId);
    if (!isTerminalRunStatus(handle.status)) {
      await this.publish(ctx, 'deployment.progress', deployment, env.name, handle.message ?? handle.status);
      return {
        output: {
          deploymentId: deployment.id,
          status: 'IN_PROGRESS',
          version: deployment.version,
          url: handle.url ?? null,
          environment: env.name,
        },
        summary: `Deployment ${handle.status}`,
        continuation: { pollAfterMs: 5_000, checkpoint: cp, message: handle.message ?? `Deploying to ${env.name}` },
      };
    }
    if (handle.status !== 'succeeded') {
      deployment = await this.prisma.deployment.update({
        where: { id: deployment.id },
        data: { status: 'FAILED', error: handle.message ?? `Provider reported ${handle.status}`, completedAt: new Date() },
      });
      await this.publish(ctx, 'deployment.failed', deployment, env.name, handle.message ?? undefined);
      throw new ToolError('external', `Deployment to ${env.name} ${handle.status}: ${handle.message ?? 'see provider logs'}`, {
        retryable: false,
      });
    }
    deployment = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: { status: 'VERIFYING', externalUrl: handle.url ?? deployment.externalUrl },
    });
    await this.publish(ctx, 'deployment.progress', deployment, env.name, 'Deployed; awaiting verification');
    return {
      output: {
        deploymentId: deployment.id,
        status: 'DEPLOYED',
        version: deployment.version,
        url: handle.url ?? deployment.externalUrl,
        environment: env.name,
      },
      summary: `Deployed ${deployment.version} to ${env.name} (pending verification)`,
      externalResources: [
        {
          provider: cicd.kind,
          type: 'DEPLOYMENT' as const,
          externalId: cp.providerId,
          key: deployment.version,
          title: `${env.name} · ${deployment.version}`,
          url: handle.url ?? undefined,
          status: 'deployed',
        },
      ],
    };
  }

  async verify(input: { deploymentId: string; rollbackOnFailure: boolean }, ctx: ToolExecutionContext) {
    let deployment = await this.prisma.deployment.findFirst({
      where: { id: input.deploymentId, organizationId: ctx.organizationId },
      include: { environment: true },
    });
    if (!deployment) throw new ToolError('not_found', 'Deployment not found', { retryable: false });
    const env = deployment.environment;
    if (!env.url) {
      throw new ToolError(
        'not_configured',
        `Environment "${env.name}" has no URL; health checks and smoke tests cannot run. Configure the environment URL.`,
        { retryable: false },
      );
    }
    const opts = { allowPrivateNetworks: this.config.outbound.allowPrivateNetworks, allowedHosts: this.config.outbound.allowedHosts };
    ctx.progress({ message: 'Running health checks…' });
    const health = await runProbes(
      env.url,
      [{ name: 'Health check', path: env.healthCheckPath, expectStatus: 200 }],
      { ...opts, retries: 5, retryDelayMs: 3_000 },
      ctx.signal,
    );
    const smokeDefs =
      (env.smokeTests as unknown as {
        name: string;
        path: string;
        method?: 'GET' | 'POST' | 'HEAD';
        expectStatus?: number;
        expectBodyContains?: string;
      }[]) ?? [];
    ctx.progress({ message: `Running ${smokeDefs.length} smoke test(s)…` });
    const smoke = smokeDefs.length
      ? await runProbes(env.url, smokeDefs, { ...opts, retries: 1, retryDelayMs: 2_000 }, ctx.signal)
      : { passed: true, results: [] as ProbeResult[] };
    const passed = health.passed && smoke.passed;
    deployment = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        healthChecks: health.results as unknown as Prisma.InputJsonValue,
        smokeTests: smoke.results as unknown as Prisma.InputJsonValue,
        ...(passed && { status: 'SUCCEEDED', completedAt: new Date() }),
      },
      include: { environment: true },
    });
    const failedChecks = [...health.results, ...smoke.results].filter((r) => r.status === 'failed');
    if (passed) {
      await this.publish(ctx, 'deployment.completed', deployment, env.name, 'Verified');
      return {
        output: {
          passed: true,
          deploymentId: deployment.id,
          healthChecks: health.results,
          smokeTests: smoke.results,
          rolledBack: false,
          summary: `${env.name}: ${health.results.length + smoke.results.length} checks passed`,
        },
        summary: `${env.name} verified: health ✓, ${smoke.results.length} smoke test(s) ✓`,
        artifacts: [
          {
            type: 'DEPLOYMENT_REPORT' as const,
            title: `Deployment ${deployment.version} → ${env.name}`,
            content: this.report(deployment.version, env.name, health.results, smoke.results, 'SUCCEEDED'),
          },
        ],
      };
    }
    let rolledBack = false;
    let rollbackNote = 'Rollback not requested';
    if (input.rollbackOnFailure) {
      const target = deployment.previousDeploymentId
        ? await this.prisma.deployment.findUnique({ where: { id: deployment.previousDeploymentId } })
        : null;
      if (target && deployment.externalId) {
        ctx.logger.warn(`Verification failed; rolling back ${env.name} to ${target.version}`);
        const cicd = await ctx.clients.cicd();
        const handle = await cicd.rollback({
          project: ctx.project!.slug,
          environment: env.name,
          deploymentId: deployment.externalId,
          targetVersion: target.version,
          targetRef: target.commitSha ?? target.ref ?? undefined,
          idempotencyKey: `${ctx.idempotencyKey}:rollback`,
          config: env.config as Record<string, unknown>,
        });
        let status = handle.status;
        for (let i = 0; i < 120 && !isTerminalRunStatus(status); i++) {
          await new Promise((r) => setTimeout(r, 5_000));
          status = (await cicd.getDeployment(handle.id)).status;
        }
        rolledBack = status === 'succeeded';
        rollbackNote = rolledBack ? `Rolled back to ${target.version}` : `Rollback ${status}`;
        await this.prisma.deployment.create({
          data: {
            organizationId: ctx.organizationId,
            projectId: deployment.projectId,
            environmentId: env.id,
            executionId: ctx.executionId ?? null,
            version: target.version,
            ref: target.ref,
            commitSha: target.commitSha,
            status: rolledBack ? 'SUCCEEDED' : 'FAILED',
            provider: cicd.name,
            externalId: handle.id,
            externalUrl: handle.url ?? null,
            previousDeploymentId: deployment.id,
            triggeredById: ctx.userId,
            startedAt: new Date(),
            completedAt: new Date(),
            error: rolledBack ? null : `Rollback ${status}`,
          },
        });
      } else {
        rollbackNote = 'No previous successful deployment to roll back to';
      }
    }
    deployment = await this.prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: rolledBack ? 'ROLLED_BACK' : 'FAILED',
        completedAt: new Date(),
        error: `${failedChecks.map((c) => `${c.name}: ${c.detail}`).join('; ')} · ${rollbackNote}`,
      },
      include: { environment: true },
    });
    await this.publish(ctx, rolledBack ? 'deployment.rolled_back' : 'deployment.failed', deployment, env.name, rollbackNote);
    return {
      output: {
        passed: false,
        deploymentId: deployment.id,
        healthChecks: health.results,
        smokeTests: smoke.results,
        rolledBack,
        summary: `${env.name}: ${failedChecks.length} check(s) failed — ${rollbackNote}`,
      },
      summary: `${env.name} verification failed (${failedChecks.map((c) => c.name).join(', ')}) — ${rollbackNote}`,
      artifacts: [
        {
          type: 'INCIDENT_REPORT' as const,
          title: `Failed deployment ${deployment.version} → ${env.name}`,
          content: this.report(deployment.version, env.name, health.results, smoke.results, deployment.status, rollbackNote),
        },
      ],
    };
  }

  private report(version: string, env: string, health: ProbeResult[], smoke: ProbeResult[], status: string, note?: string): string {
    const rows = [...health, ...smoke]
      .map(
        (r) => `| ${r.name} | ${r.status === 'passed' ? '✅' : '❌'} | ${r.httpStatus ?? '—'} | ${r.latencyMs ?? '—'} ms | ${r.detail} |`,
      )
      .join('\n');
    return `# Deployment ${version} → ${env}\n\n**Status:** ${status}${note ? ` · ${note}` : ''}\n\n| Check | Result | HTTP | Latency | Detail |\n|---|---|---|---|---|\n${rows}`;
  }

  async rollback(input: { environment: string; deploymentId?: string | null }, ctx: ToolExecutionContext) {
    const env = envFor(ctx, input.environment);
    const cp = ctx.checkpoint as { deploymentId: string; providerId: string } | undefined;
    const cicd = await ctx.clients.cicd();
    if (!cp) {
      const current = input.deploymentId
        ? await this.prisma.deployment.findFirst({ where: { id: input.deploymentId, organizationId: ctx.organizationId } })
        : await this.prisma.deployment.findFirst({
            where: { environmentId: env.id, status: 'SUCCEEDED' },
            orderBy: { completedAt: 'desc' },
          });
      if (!current?.externalId) throw new ToolError('not_found', `No deployment found to roll back in ${env.name}`, { retryable: false });
      const target = await this.previousSuccessful(env.id, current.id);
      if (!target) throw new ToolError('not_found', `No earlier successful deployment in ${env.name} to restore`, { retryable: false });
      const handle = await cicd.rollback({
        project: ctx.project!.slug,
        environment: env.name,
        deploymentId: current.externalId,
        targetVersion: target.version,
        targetRef: target.commitSha ?? target.ref ?? undefined,
        idempotencyKey: ctx.idempotencyKey,
        config: env.config,
      });
      const d = await this.prisma.deployment.create({
        data: {
          organizationId: ctx.organizationId,
          projectId: ctx.project!.id,
          environmentId: env.id,
          executionId: ctx.executionId ?? null,
          version: target.version,
          ref: target.ref,
          commitSha: target.commitSha,
          status: 'IN_PROGRESS',
          provider: cicd.name,
          externalId: handle.id,
          externalUrl: handle.url ?? null,
          previousDeploymentId: current.id,
          triggeredById: ctx.userId,
          startedAt: new Date(),
        },
      });
      await this.prisma.deployment.update({ where: { id: current.id }, data: { status: 'ROLLED_BACK', rolledBackById: d.id } });
      await this.publish(ctx, 'deployment.started', d, env.name, `Rolling back to ${target.version}`);
      return {
        output: { deploymentId: d.id, status: 'IN_PROGRESS', version: target.version },
        summary: `Rolling back ${env.name} to ${target.version}`,
        continuation: { pollAfterMs: 5_000, checkpoint: { deploymentId: d.id, providerId: handle.id }, message: 'Rolling back' },
      };
    }
    const handle = await cicd.getDeployment(cp.providerId);
    const d = await this.prisma.deployment.findUniqueOrThrow({ where: { id: cp.deploymentId } });
    if (!isTerminalRunStatus(handle.status))
      return {
        output: { deploymentId: d.id, status: 'IN_PROGRESS', version: d.version },
        summary: 'Rollback in progress',
        continuation: { pollAfterMs: 5_000, checkpoint: cp },
      };
    const ok = handle.status === 'succeeded';
    const updated = await this.prisma.deployment.update({
      where: { id: d.id },
      data: { status: ok ? 'VERIFYING' : 'FAILED', completedAt: ok ? null : new Date(), error: ok ? null : handle.message },
    });
    await this.publish(
      ctx,
      ok ? 'deployment.rolled_back' : 'deployment.failed',
      updated,
      env.name,
      ok ? `Restored ${d.version}` : (handle.message ?? undefined),
    );
    if (!ok) throw new ToolError('external', `Rollback of ${env.name} ${handle.status}`, { retryable: false });
    return {
      output: { deploymentId: d.id, status: 'ROLLED_BACK', version: d.version },
      summary: `Rolled back ${env.name} to ${d.version}`,
    };
  }

  // ───────────────────────── demo simulations ─────────────────────────

  private async simulateDeploy(input: { environment: string; ref?: string | null; commitSha?: string | null }, ctx: ToolExecutionContext) {
    const env = envFor(ctx, input.environment);
    const cp = ctx.checkpoint as { deploymentId: string; polls: number } | undefined;
    if (!cp) {
      const d = await this.prisma.deployment.create({
        data: {
          organizationId: ctx.organizationId,
          projectId: ctx.project!.id,
          environmentId: env.id,
          executionId: ctx.executionId ?? null,
          version: `v1.${Math.floor(Date.now() / 1000) % 1000}.0`,
          ref: input.ref ?? 'main',
          commitSha: input.commitSha ?? null,
          status: 'IN_PROGRESS',
          provider: 'Simulated',
          simulated: true,
          triggeredById: ctx.userId,
          startedAt: new Date(),
        },
      });
      await this.publish(ctx, 'deployment.started', d, env.name, 'Simulated deployment started');
      return {
        simulated: true,
        output: { deploymentId: d.id, status: 'IN_PROGRESS', version: d.version, url: null, environment: env.name },
        summary: `[Simulated] Deploying ${d.version} to ${env.name}`,
        continuation: { pollAfterMs: 1_500, checkpoint: { deploymentId: d.id, polls: 1 }, message: 'Simulated rollout' },
      };
    }
    const d = await this.prisma.deployment.findUniqueOrThrow({ where: { id: cp.deploymentId } });
    if (cp.polls < 3) {
      await this.publish(ctx, 'deployment.progress', d, env.name, `Rolling out (${cp.polls * 33}%)`);
      return {
        simulated: true,
        output: { deploymentId: d.id, status: 'IN_PROGRESS', version: d.version, url: null, environment: env.name },
        summary: '[Simulated] Rolling out',
        continuation: { pollAfterMs: 1_500, checkpoint: { ...cp, polls: cp.polls + 1 }, message: `Rolling out (${cp.polls * 33}%)` },
      };
    }
    const updated = await this.prisma.deployment.update({ where: { id: d.id }, data: { status: 'VERIFYING' } });
    return {
      simulated: true,
      output: { deploymentId: updated.id, status: 'DEPLOYED', version: updated.version, url: null, environment: env.name },
      summary: `[Simulated] Deployed ${updated.version} to ${env.name}`,
    };
  }

  private async simulateVerify(input: { deploymentId: string }, ctx: ToolExecutionContext) {
    const results: ProbeResult[] = [
      { name: 'Health check', status: 'passed', httpStatus: 200, latencyMs: 38, detail: '200 in 38ms (simulated)' },
      { name: 'Login page', status: 'passed', httpStatus: 200, latencyMs: 112, detail: '200 in 112ms (simulated)' },
      { name: 'Password reset endpoint', status: 'passed', httpStatus: 202, latencyMs: 87, detail: '202 in 87ms (simulated)' },
    ];
    const d = await this.prisma.deployment.update({
      where: { id: input.deploymentId },
      data: {
        status: 'SUCCEEDED',
        completedAt: new Date(),
        healthChecks: [results[0]] as unknown as Prisma.InputJsonValue,
        smokeTests: results.slice(1) as unknown as Prisma.InputJsonValue,
      },
      include: { environment: true },
    });
    await this.publish(ctx, 'deployment.completed', d, d.environment.name, 'Verified (simulated)');
    return {
      simulated: true,
      output: {
        passed: true,
        deploymentId: d.id,
        healthChecks: [results[0]],
        smokeTests: results.slice(1),
        rolledBack: false,
        summary: `[Simulated] ${d.environment.name}: 3 checks passed`,
      },
      summary: `[Simulated] ${d.environment.name} verified: health ✓, 2 smoke tests ✓`,
    };
  }

  onModuleInit(): void {
    const self = this;
    const envPermission = (input: { environment: string }, ctx: ToolExecutionContext) => {
      const env = ctx.project?.environments.find((e) => e.name === input.environment);
      return deployPermissionFor(env?.type ?? 'PRODUCTION');
    };

    this.registry.register(
      defineLooseTool({
        name: 'deploy.environment',
        title: 'Deploy',
        description: 'Deploy a ref/version to a project environment via the CI/CD provider and follow it to completion.',
        category: 'devops',
        provider: 'CUSTOM_DEVOPS',
        agent: 'release',
        inputSchema: z.object({
          environment: z.string().min(1).max(40),
          ref: z.string().max(200).nullable().optional(),
          commitSha: z.string().max(64).nullable().optional(),
          version: z.string().max(80).nullable().optional(),
          artifactRef: z.string().max(500).nullable().optional(),
        }),
        permission: envPermission,
        risk: 'production',
        sideEffects: true,
        approvalAction: 'deploy.environment',
        maxPollDurationMs: 60 * 60_000,
        defaultRetry: { maxAttempts: 2 },
        execute: (input, ctx) => self.deploy(input, ctx),
        simulate: (input, ctx) => self.simulateDeploy(input, ctx),
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'deploy.verify',
        title: 'Verify deployment',
        description: 'Run health checks and smoke tests against the deployed environment; roll back automatically on failure.',
        category: 'devops',
        provider: null,
        agent: 'qa',
        inputSchema: z.object({ deploymentId: z.string().uuid(), rollbackOnFailure: z.boolean().default(true) }),
        permission: 'qa:run',
        risk: 'write',
        sideEffects: false,
        defaultTimeoutMs: 15 * 60_000,
        execute: (input, ctx) => self.verify(input, ctx),
        simulate: (input, ctx) => self.simulateVerify(input, ctx),
      }),
    );

    this.registry.register(
      defineLooseTool({
        name: 'deploy.rollback',
        title: 'Roll back',
        description: 'Restore the previous successful deployment of an environment.',
        category: 'devops',
        provider: 'CUSTOM_DEVOPS',
        agent: 'release',
        inputSchema: z.object({ environment: z.string().min(1).max(40), deploymentId: z.string().uuid().nullable().optional() }),
        permission: envPermission,
        risk: 'production',
        sideEffects: true,
        approvalAction: 'deploy.rollback',
        maxPollDurationMs: 30 * 60_000,
        execute: (input, ctx) => self.rollback(input, ctx),
        async simulate(input, ctx) {
          const env = envFor(ctx, input.environment);
          const d = await self.prisma.deployment.create({
            data: {
              organizationId: ctx.organizationId,
              projectId: ctx.project!.id,
              environmentId: env.id,
              executionId: ctx.executionId ?? null,
              version: 'v1.0.0',
              status: 'VERIFYING',
              provider: 'Simulated',
              simulated: true,
              triggeredById: ctx.userId,
              startedAt: new Date(),
            },
          });
          return {
            simulated: true,
            output: { deploymentId: d.id, status: 'ROLLED_BACK', version: d.version },
            summary: `[Simulated] Rolled back ${env.name} to v1.0.0`,
          };
        },
      }),
    );
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, Webhook } from '@forgeline/database';
import { isUniqueViolation } from '@forgeline/database';
import { verifyGitHubSignature, verifyJiraSignature, verifyTimestampedSignature, verifyTrelloSignature } from '@forgeline/integrations';
import type { IntegrationProvider } from '@forgeline/shared';
import { PrismaService } from '../common/prisma/prisma.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { TriggersService, type ExternalEvent } from '../workflows/triggers.service';
import { ExecutionsService } from '../workflow-execution/executions.service';
import { WorkflowsService } from '../workflows/workflows.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

export interface InboundWebhook {
  provider: IntegrationProvider;
  webhookId: string;
  rawBody: Buffer;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown>;
  url: string;
}

const header = (h: InboundWebhook['headers'], name: string): string | undefined => {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * Inbound webhooks: verify signatures with the per-webhook secret, de-duplicate
 * deliveries, normalise to Forgeline events, fire event triggers and slash
 * commands (e.g. "/forgeline review" on a PR) — "do anything from anywhere".
 */
@Injectable()
export class WebhooksService {
  private readonly logger = new Logger(WebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: EncryptionService,
    private readonly audit: AuditService,
    private readonly triggers: TriggersService,
    private readonly executions: ExecutionsService,
    private readonly workflows: WorkflowsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private verify(webhook: Webhook, inbound: InboundWebhook): boolean {
    const secret = this.crypto.decrypt({ ciphertext: webhook.secretCiphertext, keyVersion: webhook.keyVersion }, `webhook:${webhook.integrationId}`);
    switch (inbound.provider) {
      case 'GITHUB':
      case 'GITHUB_ACTIONS':
        return verifyGitHubSignature(secret, inbound.rawBody, header(inbound.headers, 'x-hub-signature-256'));
      case 'JIRA':
        return verifyJiraSignature(secret, inbound.rawBody, header(inbound.headers, 'x-hub-signature'));
      case 'TRELLO':
        // Trello signs with the application secret over body + callback URL.
        return Boolean(this.config.oauth.trello.apiSecret) && verifyTrelloSignature(this.config.oauth.trello.apiSecret!, inbound.rawBody, inbound.url, header(inbound.headers, 'x-trello-webhook'));
      default:
        return verifyTimestampedSignature(secret, inbound.rawBody, header(inbound.headers, 'x-forgeline-timestamp'), header(inbound.headers, 'x-forgeline-signature'));
    }
  }

  private normalise(inbound: InboundWebhook): { deliveryId: string; events: ExternalEvent[] } {
    const b = inbound.body;
    switch (inbound.provider) {
      case 'GITHUB':
      case 'GITHUB_ACTIONS': {
        const deliveryId = header(inbound.headers, 'x-github-delivery') ?? `gh-${Date.now()}`;
        const type = header(inbound.headers, 'x-github-event') ?? 'unknown';
        const action = typeof b.action === 'string' ? `.${b.action}` : '';
        return { deliveryId, events: [{ name: `github.${type}${action}`, deliveryId, payload: b }] };
      }
      case 'JIRA': {
        const deliveryId = header(inbound.headers, 'x-atlassian-webhook-identifier') ?? `${String(b.timestamp ?? Date.now())}-${String((b.issue as { key?: string } | undefined)?.key ?? '')}`;
        const event = String(b.webhookEvent ?? 'jira:unknown');
        const events: ExternalEvent[] = [{ name: event.replace('jira:', 'jira.').replace(/_/g, '.'), deliveryId, payload: b }];
        const changelog = (b.changelog as { items?: { field: string; fromString?: string; toString?: string }[] } | undefined)?.items ?? [];
        const statusChange = changelog.find((i) => i.field === 'status');
        if (statusChange) events.push({ name: 'jira.issue.transitioned', deliveryId: `${deliveryId}:transition`, payload: { ...b, fromStatus: statusChange.fromString, toStatus: statusChange.toString } });
        return { deliveryId, events };
      }
      case 'TRELLO': {
        const action = (b.action ?? {}) as { id?: string; type?: string; data?: { listAfter?: { name: string } } };
        const deliveryId = action.id ?? `trello-${Date.now()}`;
        const events: ExternalEvent[] = [{ name: `trello.${action.type ?? 'unknown'}`, deliveryId, payload: b }];
        if (action.data?.listAfter) events.push({ name: 'trello.card.moved', deliveryId: `${deliveryId}:moved`, payload: { ...b, toList: action.data.listAfter.name } });
        return { deliveryId, events };
      }
      default: {
        const deliveryId = header(inbound.headers, 'x-forgeline-delivery') ?? String(b.id ?? Date.now());
        return { deliveryId, events: [{ name: `devops.${String(b.event ?? 'event')}`, deliveryId, payload: b }] };
      }
    }
  }

  async handle(inbound: InboundWebhook): Promise<{ status: string; executions: string[] }> {
    const webhook = await this.prisma.webhook.findUnique({ where: { id: inbound.webhookId }, include: { integration: true } });
    const providerMatches = webhook && (webhook.provider === inbound.provider || (webhook.provider === 'GITHUB' && inbound.provider === 'GITHUB_ACTIONS'));
    if (!webhook || !webhook.isActive || !providerMatches) throw AppException.notFound('Webhook');
    const signatureValid = this.verify(webhook, inbound);
    const { deliveryId, events } = this.normalise(inbound);
    let delivery;
    try {
      delivery = await this.prisma.webhookDelivery.create({
        data: { webhookId: webhook.id, organizationId: webhook.organizationId, provider: webhook.provider, deliveryId, eventType: events[0]?.name ?? 'unknown', signatureValid, payload: inbound.body as Prisma.InputJsonValue, status: signatureValid ? 'RECEIVED' : 'REJECTED' },
      });
    } catch (err) {
      if (isUniqueViolation(err)) return { status: 'duplicate', executions: [] };
      throw err;
    }
    if (!signatureValid) {
      await this.audit.record({ organizationId: webhook.organizationId, actorType: 'WEBHOOK', actorId: null, action: 'webhook.rejected', resourceType: 'webhook', resourceId: webhook.id, status: 'DENIED', output: { reason: 'invalid signature', provider: inbound.provider } });
      throw AppException.unauthorized('Invalid webhook signature', 'INVALID_SIGNATURE');
    }
    await this.prisma.webhook.update({ where: { id: webhook.id }, data: { lastDeliveryAt: new Date() } });

    const executions: string[] = [];
    try {
      for (const event of events) executions.push(...(await this.triggers.dispatchEvent(webhook.organizationId, event)));
      executions.push(...(await this.slashCommands(webhook, inbound, deliveryId)));
      await this.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: executions.length ? 'PROCESSED' : 'IGNORED', processedAt: new Date(), executionIds: executions } });
    } catch (err) {
      await this.prisma.webhookDelivery.update({ where: { id: delivery.id }, data: { status: 'FAILED', error: (err as Error).message.slice(0, 1000), processedAt: new Date() } });
      this.logger.error({ err: (err as Error).message, deliveryId }, 'Webhook processing failed');
    }
    await this.audit.record({ organizationId: webhook.organizationId, actorType: 'WEBHOOK', actorId: null, actorLabel: inbound.provider, action: 'webhook.received', resourceType: 'webhook', resourceId: webhook.id, output: { event: events[0]?.name, executions } });
    return { status: 'accepted', executions };
  }

  /**
   * "/forgeline review" on a GitHub PR, "/forgeline implement" on a Jira issue.
   * The run acts as the user who connected the integration; every tool call is
   * still permission-checked and policy gates still apply.
   */
  private async slashCommands(webhook: Webhook & { integration: { connectedById: string | null } | null }, inbound: InboundWebhook, deliveryId: string): Promise<string[]> {
    const principal = webhook.integration?.connectedById;
    if (!principal) return [];
    const b = inbound.body;
    const started: string[] = [];
    if (inbound.provider === 'GITHUB' && header(inbound.headers, 'x-github-event') === 'issue_comment' && b.action === 'created') {
      const comment = String((b.comment as { body?: string })?.body ?? '');
      const issue = b.issue as { number: number; pull_request?: unknown };
      const repoFull = String((b.repository as { full_name?: string })?.full_name ?? '');
      if (/^\/forgeline\s+review\b/im.test(comment) && issue?.pull_request) {
        const repo = await this.prisma.repository.findFirst({ where: { organizationId: webhook.organizationId, fullName: repoFull, deletedAt: null } });
        if (repo) {
          const exec = await this.executions.start({
            organizationId: webhook.organizationId,
            projectId: repo.projectId,
            userId: principal,
            title: `Review PR #${issue.number} (requested on GitHub)`,
            definition: this.workflows.templateDefinition('review_pull_request'),
            input: { pullNumber: issue.number },
            template: 'review_pull_request',
            triggerSource: 'WEBHOOK',
            idempotencyKey: `gh-cmd:${deliveryId}`,
          });
          started.push(exec.id);
        }
      }
    }
    if (inbound.provider === 'JIRA' && String(b.webhookEvent ?? '').includes('comment')) {
      const comment = (b.comment as { body?: unknown })?.body;
      const text = typeof comment === 'string' ? comment : JSON.stringify(comment ?? '');
      const issue = b.issue as { key?: string; fields?: { summary?: string; project?: { key?: string } } } | undefined;
      const match = /\/forgeline\s+(implement|plan|spec)\b/i.exec(text);
      if (match && issue?.key) {
        const project = await this.prisma.project.findFirst({ where: { organizationId: webhook.organizationId, deletedAt: null, OR: [{ key: issue.fields?.project?.key ?? '' }, { settings: { path: ['jiraProjectKey'], equals: issue.fields?.project?.key ?? '' } }] } });
        if (project) {
          const template = match[1]!.toLowerCase() === 'implement' ? 'implement_change' : match[1]!.toLowerCase() === 'plan' ? 'implementation_plan' : 'technical_spec';
          const exec = await this.executions.start({
            organizationId: webhook.organizationId,
            projectId: project.id,
            userId: principal,
            title: `${match[1]} ${issue.key} (requested in Jira)`,
            definition: this.workflows.templateDefinition(template),
            input: { requirement: `${issue.key}: ${issue.fields?.summary ?? ''}`, ticketKey: issue.key },
            template,
            triggerSource: 'WEBHOOK',
            idempotencyKey: `jira-cmd:${deliveryId}`,
          });
          started.push(exec.id);
        }
      }
    }
    return started;
  }
}

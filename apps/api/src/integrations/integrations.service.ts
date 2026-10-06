import { Inject, Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import type { Integration, Prisma } from '@forgeline/database';
import { BRAND, ToolError, type IntegrationAuthType, type IntegrationProvider } from '@forgeline/shared';
import {
  buildAuthorizeUrl,
  exchangeCode,
  generatePkce,
  GitHubClient,
  HttpDevOpsProvider,
  JiraClient,
  NotionClient,
  OAUTH_SCOPES,
  SlackClient,
  TrelloClient,
} from '@forgeline/integrations';
import { PrismaService } from '../common/prisma/prisma.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { AppException } from '../common/errors';
import { AuditService } from '../audit/audit.service';
import { EventBus } from '../events/event-bus.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import type { AuthContext } from '../common/auth/auth-context';
import { CredentialVault, type CredentialBundle } from './credential-vault.service';
import { ConnectionResolver, type IntegrationConfig } from './connection-resolver.service';
import { providerCatalog } from './catalog';

const OAUTH_PROVIDERS: IntegrationProvider[] = ['GITHUB', 'JIRA', 'NOTION', 'TRELLO'];

const tokenSchemas = {
  GITHUB: z.object({ token: z.string().min(20).max(500), apiUrl: z.string().url().optional() }),
  JIRA: z.object({ siteUrl: z.string().url(), email: z.string().email(), apiToken: z.string().min(10).max(1000) }),
  TRELLO: z.object({ apiKey: z.string().min(10).max(200).optional(), token: z.string().min(20).max(500) }),
  NOTION: z.object({ token: z.string().min(20).max(500) }),
  CUSTOM_DEVOPS: z.object({
    baseUrl: z.string().url(),
    apiToken: z.string().min(8).max(2000),
    signingSecret: z.string().min(16).max(500).optional(),
  }),
  SLACK: z.object({ webhookUrl: z.string().url() }),
  GITHUB_ACTIONS: z.object({}),
} satisfies Record<IntegrationProvider, z.ZodType>;

interface VerifiedConnection {
  authType: IntegrationAuthType;
  bundle: CredentialBundle | null;
  config: IntegrationConfig;
  accountId: string;
  accountName: string;
  scopes: string[];
  expiresAt?: Date | null;
}

/** Public shape — never includes credentials. */
export function toPublicIntegration(i: Integration) {
  return {
    id: i.id,
    provider: i.provider,
    name: i.name,
    status: i.status,
    authType: i.authType,
    scopes: i.scopes,
    externalAccountName: i.externalAccountName,
    config: i.config,
    healthStatus: i.healthStatus,
    healthMessage: i.healthMessage,
    lastHealthCheckAt: i.lastHealthCheckAt,
    lastSyncAt: i.lastSyncAt,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
  };
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CredentialVault,
    private readonly resolver: ConnectionResolver,
    private readonly audit: AuditService,
    private readonly events: EventBus,
    private readonly crypto: EncryptionService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  catalog() {
    return providerCatalog(this.config);
  }

  async list(organizationId: string) {
    const rows = await this.prisma.integration.findMany({ where: { organizationId, deletedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(toPublicIntegration);
  }

  async get(organizationId: string, id: string) {
    const i = await this.prisma.integration.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!i) throw AppException.notFound('Integration', id);
    const webhooks = await this.prisma.webhook.findMany({
      where: { integrationId: id },
      select: { id: true, events: true, isActive: true, lastDeliveryAt: true, createdAt: true },
    });
    return {
      ...toPublicIntegration(i),
      webhooks: webhooks.map((w) => ({ ...w, url: this.webhookUrl(i.provider as IntegrationProvider, w.id) })),
    };
  }

  webhookUrl(provider: IntegrationProvider, webhookId: string): string {
    return `${this.config.apiPublicUrl}/api/webhooks/${provider.toLowerCase().replace('_', '-')}/${webhookId}`;
  }

  // ── Token-based connections ──

  async connectWithToken(auth: AuthContext, provider: IntegrationProvider, payload: Record<string, unknown>) {
    const schema = tokenSchemas[provider];
    const parsed = schema.safeParse(payload ?? {});
    if (!parsed.success)
      throw AppException.badRequest(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '), 'INVALID_CREDENTIALS');
    const verified = await this.verify(auth.organizationId, provider, parsed.data as Record<string, string>);
    return this.persistConnection(auth, provider, verified);
  }

  /** Validate credentials against the live provider before storing them. */
  private async verify(organizationId: string, provider: IntegrationProvider, input: Record<string, string>): Promise<VerifiedConnection> {
    try {
      switch (provider) {
        case 'GITHUB': {
          const apiUrl = input.apiUrl ?? this.config.oauth.github.apiUrl;
          const gh = new GitHubClient({ token: input.token!, apiUrl });
          const [user, scopes] = await Promise.all([gh.getAuthenticatedUser(), gh.getTokenScopes()]);
          return {
            authType: 'API_TOKEN',
            bundle: { kind: 'github_pat', token: input.token! },
            config: { apiUrl },
            accountId: String(user.id),
            accountName: user.login,
            scopes,
          };
        }
        case 'GITHUB_ACTIONS': {
          const gh = await this.resolver.github(organizationId);
          const user = await gh.getAuthenticatedUser();
          const scopes = await gh.getTokenScopes();
          if (scopes.length && !scopes.includes('workflow') && !scopes.includes('repo')) {
            throw new ToolError('permission', 'The GitHub token lacks the "workflow" scope required for Actions');
          }
          return {
            authType: 'API_TOKEN',
            bundle: null,
            config: { usesGitHubConnection: true },
            accountId: `actions:${user.id}`,
            accountName: user.login,
            scopes,
          };
        }
        case 'JIRA': {
          const jira = new JiraClient({ type: 'basic', email: input.email!, apiToken: input.apiToken!, siteUrl: input.siteUrl! });
          const me = await jira.myself();
          return {
            authType: 'BASIC',
            bundle: { kind: 'jira_basic', email: input.email!, apiToken: input.apiToken! },
            config: { siteUrl: input.siteUrl!.replace(/\/+$/, '') },
            accountId: me.accountId,
            accountName: `${me.displayName} @ ${new URL(input.siteUrl!).host}`,
            scopes: ['basic'],
          };
        }
        case 'TRELLO': {
          const apiKey = input.apiKey ?? this.config.oauth.trello.apiKey;
          if (!apiKey) throw new ToolError('validation', 'Trello API key is required');
          const trello = new TrelloClient({ apiKey, token: input.token!, apiUrl: this.config.oauth.trello.apiUrl });
          const me = await trello.me();
          return {
            authType: 'API_TOKEN',
            bundle: { kind: 'trello', apiKey: input.apiKey, token: input.token! },
            config: {},
            accountId: me.id,
            accountName: me.username,
            scopes: ['read', 'write'],
          };
        }
        case 'NOTION': {
          const notion = new NotionClient({ token: input.token!, apiUrl: this.config.oauth.notion.apiUrl });
          const me = await notion.me();
          return {
            authType: 'API_TOKEN',
            bundle: { kind: 'notion', accessToken: input.token! },
            config: { workspaceName: me.bot?.workspace_name ?? null },
            accountId: me.id,
            accountName: me.bot?.workspace_name ?? me.name ?? 'Notion workspace',
            scopes: [],
          };
        }
        case 'CUSTOM_DEVOPS': {
          const p = new HttpDevOpsProvider({ baseUrl: input.baseUrl!, apiToken: input.apiToken!, signingSecret: input.signingSecret });
          const health = await p.healthCheck();
          if (!health.ok) throw new ToolError('external', `DevOps API health check failed: ${health.message ?? 'unhealthy'}`);
          return {
            authType: 'HMAC',
            bundle: { kind: 'devops', apiToken: input.apiToken!, signingSecret: input.signingSecret },
            config: { baseUrl: input.baseUrl!.replace(/\/+$/, '') },
            accountId: new URL(input.baseUrl!).host,
            accountName: new URL(input.baseUrl!).host,
            scopes: [],
          };
        }
        case 'SLACK': {
          // Construction validates the URL; no message is sent until a notification is requested.
          new SlackClient(input.webhookUrl!, { allowPrivateNetworks: this.config.outbound.allowPrivateNetworks });
          const url = new URL(input.webhookUrl!);
          return {
            authType: 'WEBHOOK_URL',
            bundle: { kind: 'slack', webhookUrl: input.webhookUrl! },
            config: {},
            accountId: url.pathname.split('/').slice(0, 4).join('/'),
            accountName: 'Incoming webhook',
            scopes: ['incoming-webhook'],
          };
        }
      }
    } catch (err) {
      const e = ToolError.from(err, provider.toLowerCase());
      throw AppException.badRequest(`Could not verify ${provider} credentials: ${e.message}`, 'CONNECTION_VERIFICATION_FAILED');
    }
  }

  private async persistConnection(
    auth: Pick<AuthContext, 'organizationId' | 'userId'>,
    provider: IntegrationProvider,
    v: VerifiedConnection,
  ) {
    const name = `${providerCatalog(this.config).find((p) => p.provider === provider)?.name ?? provider} · ${v.accountName}`;
    const existing = await this.prisma.integration.findFirst({
      where: { organizationId: auth.organizationId, provider, externalAccountId: v.accountId, deletedAt: null },
    });
    const data = {
      name,
      status: 'CONNECTED' as const,
      authType: v.authType,
      scopes: v.scopes,
      externalAccountId: v.accountId,
      externalAccountName: v.accountName,
      config: v.config as Prisma.InputJsonValue,
      healthStatus: 'HEALTHY' as const,
      healthMessage: 'Credentials verified',
      lastHealthCheckAt: new Date(),
      connectedById: auth.userId,
    };
    const integration = existing
      ? await this.prisma.integration.update({ where: { id: existing.id }, data })
      : await this.prisma.integration.create({ data: { ...data, organizationId: auth.organizationId, provider } });
    if (v.bundle) await this.vault.store(integration.id, v.bundle, v.expiresAt ?? null);
    await this.audit.record({
      organizationId: auth.organizationId,
      actorId: auth.userId,
      action: 'integration.connected',
      resourceType: 'integration',
      resourceId: integration.id,
      input: { provider, authType: v.authType, account: v.accountName },
    });
    await this.events.publish({
      type: 'integration.status',
      organizationId: auth.organizationId,
      data: { integrationId: integration.id, provider, status: 'CONNECTED' },
    });
    return toPublicIntegration(integration);
  }

  // ── OAuth ──

  async startOAuth(auth: AuthContext, provider: IntegrationProvider, returnTo?: string) {
    if (!OAUTH_PROVIDERS.includes(provider)) throw AppException.badRequest(`${provider} does not support OAuth`);
    const state = EncryptionService.randomToken(32);
    const pkce = provider === 'GITHUB' ? generatePkce() : null;
    const redirectUri =
      provider === 'TRELLO'
        ? `${this.config.webAppUrl}/integrations/trello/callback`
        : `${this.config.apiPublicUrl}/api/integrations/oauth/${provider.toLowerCase()}/callback`;
    const config = provider === 'TRELLO' ? { apiKey: this.config.oauth.trello.apiKey ?? '' } : this.vault.clientConfigFor(provider);
    if (provider === 'TRELLO' && !this.config.oauth.trello.apiKey) throw AppException.precondition('TRELLO_API_KEY is not configured');
    await this.prisma.oAuthState.create({
      data: {
        stateHash: EncryptionService.sha256(state),
        provider,
        organizationId: auth.organizationId,
        userId: auth.userId,
        codeVerifier: pkce ? JSON.stringify(this.crypto.encrypt(pkce.verifier, 'oauth-pkce')) : null,
        redirectUri,
        returnTo: returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/integrations',
        expiresAt: new Date(Date.now() + 10 * 60_000),
      },
    });
    return {
      authorizeUrl: buildAuthorizeUrl(
        provider,
        { config, redirectUri, state, codeChallenge: pkce?.challenge },
        this.vault.oauthEndpoints(),
      ),
    };
  }

  /** Single-use, expiring, provider-bound state validation. */
  private async consumeState(provider: IntegrationProvider, state: string, expectedUserId?: string) {
    const row = await this.prisma.oAuthState.findUnique({ where: { stateHash: EncryptionService.sha256(state) } });
    if (!row || row.provider !== provider || row.consumedAt || row.expiresAt < new Date())
      throw AppException.badRequest('Invalid or expired OAuth state', 'OAUTH_STATE_INVALID');
    if (expectedUserId && row.userId !== expectedUserId)
      throw AppException.forbidden('OAuth state does not belong to this user', 'OAUTH_STATE_MISMATCH');
    const claimed = await this.prisma.oAuthState.updateMany({ where: { id: row.id, consumedAt: null }, data: { consumedAt: new Date() } });
    if (claimed.count !== 1) throw AppException.badRequest('OAuth state already used', 'OAUTH_STATE_INVALID');
    return row;
  }

  async oauthCallback(provider: IntegrationProvider, code: string, state: string): Promise<string> {
    const row = await this.consumeState(provider, state);
    const fail = (message: string) => `${this.config.webAppUrl}${row.returnTo ?? '/integrations'}?error=${encodeURIComponent(message)}`;
    try {
      // The user must still be a member with integration:manage at completion time.
      const membership = await this.prisma.membership.findUnique({
        where: { organizationId_userId: { organizationId: row.organizationId, userId: row.userId } },
      });
      if (!membership || !['OWNER', 'ADMIN'].includes(membership.role))
        throw new ToolError('permission', 'Only organization admins can connect integrations');
      const codeVerifier = row.codeVerifier
        ? this.crypto.decrypt(JSON.parse(row.codeVerifier) as { ciphertext: string; keyVersion: number }, 'oauth-pkce')
        : undefined;
      const tokens = await exchangeCode(
        provider,
        { config: this.vault.clientConfigFor(provider), code, redirectUri: row.redirectUri, codeVerifier },
        this.vault.oauthEndpoints(),
      );
      let verified: VerifiedConnection;
      if (provider === 'GITHUB') {
        const gh = new GitHubClient({ token: tokens.accessToken, apiUrl: this.config.oauth.github.apiUrl });
        const user = await gh.getAuthenticatedUser();
        verified = {
          authType: 'OAUTH2',
          bundle: { kind: 'github_oauth', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
          config: { apiUrl: this.config.oauth.github.apiUrl },
          accountId: String(user.id),
          accountName: user.login,
          scopes: tokens.scopes.length ? tokens.scopes : OAUTH_SCOPES.GITHUB!,
          expiresAt: tokens.expiresAt,
        };
      } else if (provider === 'JIRA') {
        const extra = tokens.extra as { cloudId: string; siteUrl: string; siteName: string };
        verified = {
          authType: 'OAUTH2',
          bundle: { kind: 'jira_oauth', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
          config: { cloudId: extra.cloudId, siteUrl: extra.siteUrl },
          accountId: extra.cloudId,
          accountName: extra.siteName,
          scopes: tokens.scopes,
          expiresAt: tokens.expiresAt,
        };
      } else {
        const extra = tokens.extra as { workspaceId: string; workspaceName: string | null };
        verified = {
          authType: 'OAUTH2',
          bundle: { kind: 'notion', accessToken: tokens.accessToken, refreshToken: tokens.refreshToken },
          config: { workspaceName: extra.workspaceName },
          accountId: extra.workspaceId,
          accountName: extra.workspaceName ?? 'Notion workspace',
          scopes: [],
          expiresAt: tokens.expiresAt,
        };
      }
      await this.persistConnection({ organizationId: row.organizationId, userId: row.userId }, provider, verified);
      return `${this.config.webAppUrl}${row.returnTo ?? '/integrations'}?connected=${provider}`;
    } catch (err) {
      this.logger.warn({ err: (err as Error).message, provider }, 'OAuth callback failed');
      await this.audit.record({
        organizationId: row.organizationId,
        actorId: row.userId,
        action: 'integration.oauth_failed',
        resourceType: 'integration',
        status: 'FAILURE',
        output: { provider, error: (err as Error).message },
      });
      return fail((err as Error).message);
    }
  }

  async completeTrello(auth: AuthContext, state: string, token: string) {
    await this.consumeState('TRELLO', state, auth.userId);
    const verified = await this.verify(auth.organizationId, 'TRELLO', { token });
    return this.persistConnection(auth, 'TRELLO', verified);
  }

  // ── Lifecycle ──

  async disconnect(auth: AuthContext, id: string) {
    const integration = await this.prisma.integration.findFirst({ where: { id, organizationId: auth.organizationId, deletedAt: null } });
    if (!integration) throw AppException.notFound('Integration', id);
    await this.prisma.$transaction([
      this.prisma.integrationCredential.deleteMany({ where: { integrationId: id } }),
      this.prisma.webhook.updateMany({ where: { integrationId: id }, data: { isActive: false } }),
      this.prisma.integration.update({
        where: { id },
        data: { status: 'DISCONNECTED', healthStatus: 'UNKNOWN', healthMessage: 'Disconnected', deletedAt: new Date() },
      }),
    ]);
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'integration.disconnected',
      resourceType: 'integration',
      resourceId: id,
      input: { provider: integration.provider },
    });
    await this.events.publish({
      type: 'integration.status',
      organizationId: auth.organizationId,
      data: { integrationId: id, provider: integration.provider, status: 'DISCONNECTED' },
    });
  }

  async checkHealth(organizationId: string, id: string) {
    const integration = await this.prisma.integration.findFirst({ where: { id, organizationId, deletedAt: null } });
    if (!integration) throw AppException.notFound('Integration', id);
    const provider = integration.provider as IntegrationProvider;
    let healthStatus: 'HEALTHY' | 'UNHEALTHY' | 'DEGRADED' = 'HEALTHY';
    let healthMessage = 'OK';
    const started = Date.now();
    try {
      const clients = this.resolver.clientsFor(organizationId, null);
      switch (provider) {
        case 'GITHUB':
        case 'GITHUB_ACTIONS': {
          const gh = await clients.github();
          const res = await gh.http.request<unknown>('/rate_limit');
          const remaining = Number(res.headers.get('x-ratelimit-remaining') ?? '5000');
          if (remaining < 100) {
            healthStatus = 'DEGRADED';
            healthMessage = `Rate limit nearly exhausted (${remaining} remaining)`;
          } else healthMessage = `Reachable · ${remaining} API calls remaining`;
          break;
        }
        case 'JIRA':
          healthMessage = `Authenticated as ${(await (await clients.jira()).myself()).displayName}`;
          break;
        case 'TRELLO':
          healthMessage = `Authenticated as ${(await (await clients.trello()).me()).username}`;
          break;
        case 'NOTION':
          await (await clients.notion()).me();
          healthMessage = 'Authenticated';
          break;
        case 'CUSTOM_DEVOPS': {
          const h = await this.resolver
            .buildDevOps(await this.vault.load(id, provider), integration.config as IntegrationConfig)
            .healthCheck();
          healthStatus = h.ok ? 'HEALTHY' : 'UNHEALTHY';
          healthMessage = h.message ?? (h.ok ? 'OK' : 'Unhealthy');
          break;
        }
        case 'SLACK':
          healthMessage = 'Webhook configured (verified on next notification)';
          break;
      }
    } catch (err) {
      const e = ToolError.from(err);
      healthStatus = 'UNHEALTHY';
      healthMessage = e.message.slice(0, 300);
    }
    healthMessage = `${healthMessage} (${Date.now() - started}ms)`;
    const status = healthStatus === 'UNHEALTHY' ? 'ERROR' : 'CONNECTED';
    const updated = await this.prisma.integration.update({
      where: { id },
      data: { healthStatus, healthMessage, lastHealthCheckAt: new Date(), status },
    });
    if (integration.healthStatus !== healthStatus) {
      await this.events.publish({
        type: 'integration.status',
        organizationId,
        data: { integrationId: id, provider, status, healthStatus },
      });
    }
    return toPublicIntegration(updated);
  }

  /** Called by the tool executor when a provider rejects our credentials. */
  async markAuthFailure(organizationId: string, provider: IntegrationProvider, message: string): Promise<void> {
    const integration = await this.resolver.findActive(organizationId, provider === 'GITHUB_ACTIONS' ? 'GITHUB' : provider);
    if (!integration) return;
    await this.prisma.integration.update({
      where: { id: integration.id },
      data: { status: 'ERROR', healthStatus: 'UNHEALTHY', healthMessage: message.slice(0, 300), lastHealthCheckAt: new Date() },
    });
    await this.events.publish({
      type: 'integration.status',
      organizationId,
      data: { integrationId: integration.id, provider, status: 'ERROR' },
    });
  }

  async listGitHubRepositories(organizationId: string, page = 1) {
    const gh = await this.resolver.github(organizationId);
    const repos = await gh.listRepositories(page, 50);
    await this.prisma.integration.updateMany({
      where: { organizationId, provider: 'GITHUB', deletedAt: null },
      data: { lastSyncAt: new Date() },
    });
    return repos.map((r) => ({
      fullName: r.full_name,
      private: r.private,
      defaultBranch: r.default_branch,
      language: r.language ?? null,
      description: r.description ?? null,
      url: r.html_url,
      pushedAt: r.pushed_at ?? null,
    }));
  }

  /** Create an inbound webhook endpoint (and register it with the provider when possible). */
  async enableWebhook(auth: AuthContext, integrationId: string, options: { repository?: string; boardId?: string }) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organizationId: auth.organizationId, deletedAt: null },
    });
    if (!integration) throw AppException.notFound('Integration', integrationId);
    const provider = integration.provider as IntegrationProvider;
    const secret = EncryptionService.randomToken(32);
    const enc = this.crypto.encrypt(secret, `webhook:${integrationId}`);
    const events =
      provider === 'GITHUB'
        ? ['pull_request', 'push', 'workflow_run', 'issue_comment']
        : provider === 'JIRA'
          ? ['jira:issue_created', 'jira:issue_updated']
          : provider === 'TRELLO'
            ? ['updateCard']
            : ['deployment.completed', 'pipeline.completed'];
    const webhook = await this.prisma.webhook.create({
      data: {
        organizationId: auth.organizationId,
        integrationId,
        provider,
        secretCiphertext: enc.ciphertext,
        keyVersion: enc.keyVersion,
        events,
      },
    });
    const url = this.webhookUrl(provider, webhook.id);
    let registered = false;
    let instructions: string | null = null;
    try {
      if (provider === 'GITHUB' && options.repository) {
        const [owner, repo] = options.repository.split('/');
        const gh = await this.resolver.github(auth.organizationId);
        const hook = await gh.createRepositoryWebhook(owner!, repo!, { url, secret, events });
        await this.prisma.webhook.update({ where: { id: webhook.id }, data: { externalHookId: String(hook.id) } });
        registered = true;
      } else if (provider === 'TRELLO' && options.boardId) {
        const trello = await this.resolver.clientsFor(auth.organizationId, null).trello();
        const hook = await trello.createWebhook(url, options.boardId, BRAND.name);
        await this.prisma.webhook.update({ where: { id: webhook.id }, data: { externalHookId: hook.id } });
        registered = true;
      } else {
        instructions = `Configure a webhook in ${provider} pointing to the URL below, using the signing secret shown once.`;
      }
    } catch (err) {
      instructions = `Automatic registration failed (${(err as Error).message}). Configure the webhook manually.`;
    }
    await this.audit.record({
      organizationId: auth.organizationId,
      action: 'webhook.created',
      resourceType: 'webhook',
      resourceId: webhook.id,
      input: { provider, registered },
    });
    // The signing secret is displayed exactly once so it can be configured manually when needed.
    return { id: webhook.id, url, events, registered, instructions, secret: registered ? null : secret };
  }
}

import { Inject, Injectable } from '@nestjs/common';
import { ToolError, type IntegrationProvider } from '@forgeline/shared';
import {
  GitHubActionsCiCdProvider,
  GitHubClient,
  HttpDevOpsProvider,
  JiraClient,
  NotionClient,
  SlackClient,
  TrelloClient,
  type CiCdProvider,
  type IntegrationClients,
  type ProjectContext,
} from '@forgeline/integrations';
import type { Integration } from '@forgeline/database';
import { PrismaService } from '../common/prisma/prisma.service';
import { APP_CONFIG, type AppConfig } from '../config/configuration';
import { CredentialVault, type CredentialBundle } from './credential-vault.service';

const PROVIDER_LABEL: Record<IntegrationProvider, string> = {
  GITHUB: 'GitHub',
  GITHUB_ACTIONS: 'GitHub Actions',
  JIRA: 'Jira',
  TRELLO: 'Trello',
  NOTION: 'Notion',
  CUSTOM_DEVOPS: 'DevOps CI/CD',
  SLACK: 'Slack',
};

export interface IntegrationConfig {
  apiUrl?: string;
  siteUrl?: string;
  cloudId?: string;
  baseUrl?: string;
  workspaceName?: string | null;
  [key: string]: unknown;
}

/**
 * Builds authenticated provider clients for one organization. Credentials are
 * decrypted only inside this process and handed to clients — never returned.
 */
@Injectable()
export class ConnectionResolver {
  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: CredentialVault,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async findActive(organizationId: string, provider: IntegrationProvider): Promise<Integration | null> {
    return this.prisma.integration.findFirst({
      where: { organizationId, provider, deletedAt: null, status: { in: ['CONNECTED', 'ERROR'] } },
      orderBy: { updatedAt: 'desc' },
    });
  }

  private async require(
    organizationId: string,
    provider: IntegrationProvider,
  ): Promise<{ integration: Integration; bundle: CredentialBundle }> {
    const integration = await this.findActive(organizationId, provider);
    if (!integration) {
      const expired = await this.prisma.integration.findFirst({ where: { organizationId, provider, deletedAt: null, status: 'EXPIRED' } });
      throw new ToolError(
        expired ? 'auth' : 'not_configured',
        expired
          ? `${PROVIDER_LABEL[provider]} authorization expired — reconnect it on the Integrations page`
          : `${PROVIDER_LABEL[provider]} is not connected. Connect it on the Integrations page.`,
        { retryable: false, provider: provider.toLowerCase() },
      );
    }
    return { integration, bundle: await this.vault.load(integration.id, provider) };
  }

  buildGitHub(bundle: CredentialBundle, cfg: IntegrationConfig): GitHubClient {
    const token = bundle.kind === 'github_oauth' ? bundle.accessToken : bundle.kind === 'github_pat' ? bundle.token : null;
    if (!token) throw new ToolError('internal', 'Unexpected GitHub credential type', { retryable: false });
    return new GitHubClient({ token, apiUrl: cfg.apiUrl ?? this.config.oauth.github.apiUrl });
  }

  buildJira(bundle: CredentialBundle, cfg: IntegrationConfig): JiraClient {
    if (bundle.kind === 'jira_oauth') {
      if (!cfg.cloudId) throw new ToolError('not_configured', 'Jira cloud id missing; reconnect Jira', { retryable: false });
      return new JiraClient(
        { type: 'oauth', accessToken: bundle.accessToken, cloudId: cfg.cloudId, apiBaseUrl: this.config.oauth.jira.apiUrl },
        { siteUrl: cfg.siteUrl },
      );
    }
    if (bundle.kind === 'jira_basic') {
      if (!cfg.siteUrl) throw new ToolError('not_configured', 'Jira site URL missing', { retryable: false });
      return new JiraClient({ type: 'basic', email: bundle.email, apiToken: bundle.apiToken, siteUrl: cfg.siteUrl });
    }
    throw new ToolError('internal', 'Unexpected Jira credential type', { retryable: false });
  }

  buildTrello(bundle: CredentialBundle): TrelloClient {
    if (bundle.kind !== 'trello') throw new ToolError('internal', 'Unexpected Trello credential type', { retryable: false });
    const apiKey = bundle.apiKey ?? this.config.oauth.trello.apiKey;
    if (!apiKey) throw new ToolError('not_configured', 'Trello API key missing', { retryable: false });
    return new TrelloClient({ apiKey, token: bundle.token, apiUrl: this.config.oauth.trello.apiUrl });
  }

  buildNotion(bundle: CredentialBundle): NotionClient {
    if (bundle.kind !== 'notion') throw new ToolError('internal', 'Unexpected Notion credential type', { retryable: false });
    return new NotionClient({ token: bundle.accessToken, apiUrl: this.config.oauth.notion.apiUrl });
  }

  buildDevOps(bundle: CredentialBundle, cfg: IntegrationConfig): HttpDevOpsProvider {
    if (bundle.kind !== 'devops' || !cfg.baseUrl)
      throw new ToolError('not_configured', 'DevOps integration misconfigured', { retryable: false });
    return new HttpDevOpsProvider({ baseUrl: cfg.baseUrl, apiToken: bundle.apiToken, signingSecret: bundle.signingSecret });
  }

  buildSlack(bundle: CredentialBundle): SlackClient {
    if (bundle.kind !== 'slack') throw new ToolError('internal', 'Unexpected Slack credential type', { retryable: false });
    return new SlackClient(bundle.webhookUrl, { allowPrivateNetworks: this.config.outbound.allowPrivateNetworks });
  }

  async github(organizationId: string): Promise<GitHubClient> {
    const { integration, bundle } = await this.require(organizationId, 'GITHUB');
    return this.buildGitHub(bundle, integration.config as IntegrationConfig);
  }

  /** Lazily-resolved clients for tool execution. */
  clientsFor(organizationId: string, project: ProjectContext | null): IntegrationClients {
    const cache = new Map<string, Promise<unknown>>();
    const memo = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
      if (!cache.has(key))
        cache.set(
          key,
          fn().catch((err) => {
            cache.delete(key);
            throw err;
          }),
        );
      return cache.get(key) as Promise<T>;
    };
    return {
      github: () => memo('github', () => this.github(organizationId)),
      jira: () =>
        memo('jira', async () => {
          const { integration, bundle } = await this.require(organizationId, 'JIRA');
          return this.buildJira(bundle, integration.config as IntegrationConfig);
        }),
      trello: () => memo('trello', async () => this.buildTrello((await this.require(organizationId, 'TRELLO')).bundle)),
      notion: () => memo('notion', async () => this.buildNotion((await this.require(organizationId, 'NOTION')).bundle)),
      slack: () => memo('slack', async () => this.buildSlack((await this.require(organizationId, 'SLACK')).bundle)),
      cicd: () => memo('cicd', () => this.cicd(organizationId, project)),
      connected: () => memo('connected', () => this.connectedProviders(organizationId)),
    };
  }

  async connectedProviders(organizationId: string): Promise<IntegrationProvider[]> {
    const rows = await this.prisma.integration.findMany({
      where: { organizationId, deletedAt: null, status: { in: ['CONNECTED', 'ERROR'] } },
      select: { provider: true },
    });
    return [...new Set(rows.map((r) => r.provider as IntegrationProvider))];
  }

  /** CI/CD provider selection: project preference, else custom DevOps, else GitHub Actions. */
  async cicd(organizationId: string, project: ProjectContext | null): Promise<CiCdProvider> {
    const preferred = project?.settings.cicdProvider;
    const connected = await this.connectedProviders(organizationId);
    const useDevOps = preferred ? preferred === 'CUSTOM_DEVOPS' : connected.includes('CUSTOM_DEVOPS');
    if (useDevOps) {
      const { integration, bundle } = await this.require(organizationId, 'CUSTOM_DEVOPS');
      return this.buildDevOps(bundle, integration.config as IntegrationConfig);
    }
    if (!connected.includes('GITHUB_ACTIONS') && !connected.includes('GITHUB')) {
      throw new ToolError(
        'not_configured',
        'No CI/CD provider connected. Connect Forgeline DevOps or GitHub Actions on the Integrations page.',
        { retryable: false },
      );
    }
    const repo = project?.repository;
    if (!repo)
      throw new ToolError('not_configured', 'GitHub Actions CI/CD requires a repository linked to the project', { retryable: false });
    const gh = await this.github(organizationId);
    return new GitHubActionsCiCdProvider(gh, {
      owner: repo.owner,
      repo: repo.name,
      ciWorkflow: repo.settings.ciWorkflow,
      deployWorkflow: repo.settings.deployWorkflow,
      defaultRef: repo.defaultBranch,
    });
  }
}

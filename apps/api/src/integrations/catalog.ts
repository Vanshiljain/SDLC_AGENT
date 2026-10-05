import type { IntegrationAuthType, IntegrationProvider } from '@forgeline/shared';
import type { AppConfig } from '../config/configuration';

export interface CredentialField {
  name: string;
  label: string;
  type: 'text' | 'password' | 'url' | 'email';
  required: boolean;
  secret: boolean;
  placeholder?: string;
  help?: string;
}

export interface ProviderDescriptor {
  provider: IntegrationProvider;
  name: string;
  description: string;
  capabilities: string[];
  authMethods: { type: IntegrationAuthType; label: string; available: boolean; fields: CredentialField[]; unavailableReason?: string }[];
  docsUrl: string;
  webhookSupport: boolean;
}

/** Static provider catalog; availability of OAuth depends on configuration. */
export function providerCatalog(config: AppConfig): ProviderDescriptor[] {
  const oauthMissing = (vars: string) => `Set ${vars} on the server to enable OAuth`;
  return [
    {
      provider: 'GITHUB',
      name: 'GitHub',
      description: 'Repositories, branches, commits, pull requests, reviews, issues and code search.',
      capabilities: ['Repositories', 'Branches', 'Commits', 'Pull requests', 'Reviews', 'Issues', 'Code search', 'Webhooks'],
      authMethods: [
        { type: 'OAUTH2', label: 'Connect with GitHub', available: Boolean(config.oauth.github.clientId && config.oauth.github.clientSecret), unavailableReason: oauthMissing('GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET'), fields: [] },
        {
          type: 'API_TOKEN',
          label: 'Personal access token',
          available: true,
          fields: [
            { name: 'token', label: 'Token', type: 'password', required: true, secret: true, help: 'Fine-grained token with Contents, Pull requests, Issues, Actions and Workflows read/write.' },
            { name: 'apiUrl', label: 'API URL (GitHub Enterprise)', type: 'url', required: false, secret: false, placeholder: 'https://api.github.com' },
          ],
        },
      ],
      docsUrl: 'https://docs.github.com/en/rest',
      webhookSupport: true,
    },
    {
      provider: 'GITHUB_ACTIONS',
      name: 'GitHub Actions',
      description: 'Trigger workflows, follow runs and jobs, retrieve logs, retry failures. Uses your GitHub connection.',
      capabilities: ['Trigger workflow', 'Run status', 'Job status', 'Logs', 'Retry'],
      authMethods: [{ type: 'API_TOKEN', label: 'Use GitHub connection', available: true, fields: [] }],
      docsUrl: 'https://docs.github.com/en/rest/actions',
      webhookSupport: true,
    },
    {
      provider: 'JIRA',
      name: 'Jira',
      description: 'Create, update, search, comment, transition and attach to issues.',
      capabilities: ['Create issue', 'Update issue', 'Search (JQL)', 'Comments', 'Transitions', 'Attachments', 'Webhooks'],
      authMethods: [
        { type: 'OAUTH2', label: 'Connect with Atlassian', available: Boolean(config.oauth.jira.clientId && config.oauth.jira.clientSecret), unavailableReason: oauthMissing('JIRA_CLIENT_ID / JIRA_CLIENT_SECRET'), fields: [] },
        {
          type: 'BASIC',
          label: 'API token',
          available: true,
          fields: [
            { name: 'siteUrl', label: 'Site URL', type: 'url', required: true, secret: false, placeholder: 'https://your-team.atlassian.net' },
            { name: 'email', label: 'Account email', type: 'email', required: true, secret: false },
            { name: 'apiToken', label: 'API token', type: 'password', required: true, secret: true, help: 'Create at id.atlassian.com → Security → API tokens.' },
          ],
        },
      ],
      docsUrl: 'https://developer.atlassian.com/cloud/jira/platform/rest/v3/',
      webhookSupport: true,
    },
    {
      provider: 'TRELLO',
      name: 'Trello',
      description: 'Boards, cards, lists, comments and attachments.',
      capabilities: ['Create board', 'Create/update card', 'Move card', 'Comments', 'Attachments'],
      authMethods: [
        { type: 'OAUTH2', label: 'Authorize with Trello', available: Boolean(config.oauth.trello.apiKey), unavailableReason: 'Set TRELLO_API_KEY on the server', fields: [] },
        {
          type: 'API_TOKEN',
          label: 'API key + token',
          available: true,
          fields: [
            { name: 'apiKey', label: 'API key', type: 'text', required: !config.oauth.trello.apiKey, secret: false },
            { name: 'token', label: 'Token', type: 'password', required: true, secret: true },
          ],
        },
      ],
      docsUrl: 'https://developer.atlassian.com/cloud/trello/rest/',
      webhookSupport: true,
    },
    {
      provider: 'NOTION',
      name: 'Notion',
      description: 'Create and update pages, append blocks, search and read documentation.',
      capabilities: ['Create page', 'Update page', 'Append blocks', 'Search', 'Read content'],
      authMethods: [
        { type: 'OAUTH2', label: 'Connect with Notion', available: Boolean(config.oauth.notion.clientId && config.oauth.notion.clientSecret), unavailableReason: oauthMissing('NOTION_CLIENT_ID / NOTION_CLIENT_SECRET'), fields: [] },
        { type: 'API_TOKEN', label: 'Internal integration token', available: true, fields: [{ name: 'token', label: 'Integration secret', type: 'password', required: true, secret: true, help: 'Share the parent page with the integration.' }] },
      ],
      docsUrl: 'https://developers.notion.com/reference',
      webhookSupport: false,
    },
    {
      provider: 'CUSTOM_DEVOPS',
      name: 'Forgeline DevOps (CI/CD)',
      description: 'Your CI/CD platform: build, test, lint, security scans, artifacts, containers, deploy, rollback, environments.',
      capabilities: ['Build', 'Test', 'Lint', 'Security scan', 'Artifacts', 'Container build', 'Image scan', 'Deploy', 'Rollback', 'Environments'],
      authMethods: [
        {
          type: 'HMAC',
          label: 'API endpoint + token',
          available: true,
          fields: [
            { name: 'baseUrl', label: 'API base URL', type: 'url', required: true, secret: false, placeholder: 'https://devops.internal.example.com' },
            { name: 'apiToken', label: 'API token', type: 'password', required: true, secret: true },
            { name: 'signingSecret', label: 'Request signing secret', type: 'password', required: false, secret: true, help: 'HMAC-SHA256 secret used to sign requests (recommended).' },
          ],
        },
      ],
      docsUrl: '/docs/INTEGRATIONS.md#custom-devops-contract',
      webhookSupport: true,
    },
    {
      provider: 'SLACK',
      name: 'Slack',
      description: 'Notify your team about runs, approvals and deployments.',
      capabilities: ['Post messages'],
      authMethods: [{ type: 'WEBHOOK_URL', label: 'Incoming webhook', available: true, fields: [{ name: 'webhookUrl', label: 'Webhook URL', type: 'password', required: true, secret: true, placeholder: 'https://hooks.slack.com/services/…' }] }],
      docsUrl: 'https://api.slack.com/messaging/webhooks',
      webhookSupport: false,
    },
  ];
}

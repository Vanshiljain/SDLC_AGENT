import { createHash, randomBytes } from 'node:crypto';
import { ToolError, type IntegrationProvider } from '@forgeline/shared';
import { HttpClient } from '../core/http';

/**
 * OAuth 2.0 flows for providers that support it. The API owns state storage
 * (hashed, single-use, bound to user + organization) and credential
 * encryption; this module only speaks each provider's protocol.
 */

export interface OAuthClientConfig {
  clientId: string;
  clientSecret: string;
}

export interface OAuthEndpoints {
  githubWebUrl: string;
  githubApiUrl: string;
  atlassianAuthUrl: string;
  atlassianApiUrl: string;
  notionApiUrl: string;
  trelloWebUrl: string;
}

export const DEFAULT_OAUTH_ENDPOINTS: OAuthEndpoints = {
  githubWebUrl: 'https://github.com',
  githubApiUrl: 'https://api.github.com',
  atlassianAuthUrl: 'https://auth.atlassian.com',
  atlassianApiUrl: 'https://api.atlassian.com',
  notionApiUrl: 'https://api.notion.com/v1',
  trelloWebUrl: 'https://trello.com',
};

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes: string[];
  tokenType?: string;
  /** Provider-specific extras (cloud id, workspace id…). Non-secret. */
  extra?: Record<string, unknown>;
}

export const OAUTH_SCOPES: Partial<Record<IntegrationProvider, string[]>> = {
  GITHUB: ['repo', 'workflow', 'read:user', 'read:org'],
  GITHUB_ACTIONS: ['repo', 'workflow', 'read:user'],
  JIRA: ['read:jira-work', 'write:jira-work', 'read:jira-user', 'manage:jira-webhook', 'offline_access'],
  NOTION: [],
};

export function generatePkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function buildAuthorizeUrl(
  provider: IntegrationProvider,
  params: { config: OAuthClientConfig | { apiKey: string }; redirectUri: string; state: string; codeChallenge?: string; appName?: string },
  endpoints: OAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS,
): string {
  switch (provider) {
    case 'GITHUB':
    case 'GITHUB_ACTIONS': {
      const c = params.config as OAuthClientConfig;
      const u = new URL('/login/oauth/authorize', endpoints.githubWebUrl);
      u.searchParams.set('client_id', c.clientId);
      u.searchParams.set('redirect_uri', params.redirectUri);
      u.searchParams.set('scope', OAUTH_SCOPES[provider]!.join(' '));
      u.searchParams.set('state', params.state);
      u.searchParams.set('allow_signup', 'false');
      if (params.codeChallenge) {
        u.searchParams.set('code_challenge', params.codeChallenge);
        u.searchParams.set('code_challenge_method', 'S256');
      }
      return u.toString();
    }
    case 'JIRA': {
      const c = params.config as OAuthClientConfig;
      const u = new URL('/authorize', endpoints.atlassianAuthUrl);
      u.searchParams.set('audience', 'api.atlassian.com');
      u.searchParams.set('client_id', c.clientId);
      u.searchParams.set('scope', OAUTH_SCOPES.JIRA!.join(' '));
      u.searchParams.set('redirect_uri', params.redirectUri);
      u.searchParams.set('state', params.state);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('prompt', 'consent');
      return u.toString();
    }
    case 'NOTION': {
      const c = params.config as OAuthClientConfig;
      const u = new URL(`${endpoints.notionApiUrl.replace(/\/+$/, '')}/oauth/authorize`);
      u.searchParams.set('client_id', c.clientId);
      u.searchParams.set('response_type', 'code');
      u.searchParams.set('owner', 'user');
      u.searchParams.set('redirect_uri', params.redirectUri);
      u.searchParams.set('state', params.state);
      return u.toString();
    }
    case 'TRELLO': {
      // Trello issues a user token via its authorize page (token returned in the URL fragment).
      const c = params.config as { apiKey: string };
      const u = new URL('/1/authorize', endpoints.trelloWebUrl);
      u.searchParams.set('expiration', 'never');
      u.searchParams.set('name', params.appName ?? 'Forgeline');
      u.searchParams.set('scope', 'read,write');
      u.searchParams.set('response_type', 'token');
      u.searchParams.set('key', c.apiKey);
      u.searchParams.set('callback_method', 'fragment');
      u.searchParams.set('return_url', `${params.redirectUri}?state=${encodeURIComponent(params.state)}`);
      return u.toString();
    }
    default:
      throw new ToolError('validation', `${provider} does not support OAuth`, { retryable: false });
  }
}

export async function exchangeCode(
  provider: IntegrationProvider,
  params: { config: OAuthClientConfig; code: string; redirectUri: string; codeVerifier?: string },
  endpoints: OAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS,
  fetchImpl?: typeof fetch,
): Promise<TokenSet> {
  switch (provider) {
    case 'GITHUB':
    case 'GITHUB_ACTIONS': {
      const http = new HttpClient({ baseUrl: endpoints.githubWebUrl, provider: 'github-oauth', fetchImpl });
      const res = await http.post<{
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
        error?: string;
        error_description?: string;
      }>('/login/oauth/access_token', {
        client_id: params.config.clientId,
        client_secret: params.config.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
        ...(params.codeVerifier && { code_verifier: params.codeVerifier }),
      });
      if (!res.access_token)
        throw new ToolError('auth', `GitHub OAuth failed: ${res.error_description ?? res.error ?? 'no token returned'}`, {
          retryable: false,
        });
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : undefined,
        scopes: (res.scope ?? '').split(/[ ,]/).filter(Boolean),
        tokenType: res.token_type,
      };
    }
    case 'JIRA': {
      const http = new HttpClient({ baseUrl: endpoints.atlassianAuthUrl, provider: 'atlassian-oauth', fetchImpl });
      const res = await http.post<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>('/oauth/token', {
        grant_type: 'authorization_code',
        client_id: params.config.clientId,
        client_secret: params.config.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
      });
      const api = new HttpClient({
        baseUrl: endpoints.atlassianApiUrl,
        provider: 'atlassian',
        fetchImpl,
        defaultHeaders: { Authorization: `Bearer ${res.access_token}` },
      });
      const resources = await api.get<{ id: string; url: string; name: string; scopes: string[] }[]>('/oauth/token/accessible-resources');
      const site = resources[0];
      if (!site) throw new ToolError('auth', 'The Atlassian account has no accessible Jira sites', { retryable: false });
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        expiresAt: new Date(Date.now() + res.expires_in * 1000),
        scopes: res.scope.split(' ').filter(Boolean),
        extra: {
          cloudId: site.id,
          siteUrl: site.url,
          siteName: site.name,
          sites: resources.map((r) => ({ id: r.id, url: r.url, name: r.name })),
        },
      };
    }
    case 'NOTION': {
      const http = new HttpClient({ baseUrl: endpoints.notionApiUrl, provider: 'notion-oauth', fetchImpl });
      const basic = Buffer.from(`${params.config.clientId}:${params.config.clientSecret}`).toString('base64');
      const res = await http.post<{
        access_token: string;
        refresh_token?: string;
        expires_in?: number;
        workspace_id: string;
        workspace_name?: string;
        bot_id: string;
      }>(
        '/oauth/token',
        { grant_type: 'authorization_code', code: params.code, redirect_uri: params.redirectUri },
        { headers: { Authorization: `Basic ${basic}` } },
      );
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token,
        expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : undefined,
        scopes: [],
        extra: { workspaceId: res.workspace_id, workspaceName: res.workspace_name ?? null, botId: res.bot_id },
      };
    }
    default:
      throw new ToolError('validation', `${provider} does not support code exchange`, { retryable: false });
  }
}

export async function refreshAccessToken(
  provider: IntegrationProvider,
  params: { config: OAuthClientConfig; refreshToken: string },
  endpoints: OAuthEndpoints = DEFAULT_OAUTH_ENDPOINTS,
  fetchImpl?: typeof fetch,
): Promise<TokenSet> {
  switch (provider) {
    case 'GITHUB':
    case 'GITHUB_ACTIONS': {
      const http = new HttpClient({ baseUrl: endpoints.githubWebUrl, provider: 'github-oauth', fetchImpl });
      const res = await http.post<{ access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error?: string }>(
        '/login/oauth/access_token',
        {
          client_id: params.config.clientId,
          client_secret: params.config.clientSecret,
          grant_type: 'refresh_token',
          refresh_token: params.refreshToken,
        },
      );
      if (!res.access_token) throw new ToolError('auth', `GitHub token refresh failed: ${res.error ?? 'unknown'}`, { retryable: false });
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token ?? params.refreshToken,
        expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : undefined,
        scopes: (res.scope ?? '').split(/[ ,]/).filter(Boolean),
      };
    }
    case 'JIRA': {
      const http = new HttpClient({ baseUrl: endpoints.atlassianAuthUrl, provider: 'atlassian-oauth', fetchImpl });
      // Atlassian rotates refresh tokens: always persist the returned one.
      const res = await http.post<{ access_token: string; refresh_token?: string; expires_in: number; scope: string }>(
        '/oauth/token',
        {
          grant_type: 'refresh_token',
          client_id: params.config.clientId,
          client_secret: params.config.clientSecret,
          refresh_token: params.refreshToken,
        },
        { retry: true },
      );
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token ?? params.refreshToken,
        expiresAt: new Date(Date.now() + res.expires_in * 1000),
        scopes: res.scope.split(' ').filter(Boolean),
      };
    }
    case 'NOTION': {
      const http = new HttpClient({ baseUrl: endpoints.notionApiUrl, provider: 'notion-oauth', fetchImpl });
      const basic = Buffer.from(`${params.config.clientId}:${params.config.clientSecret}`).toString('base64');
      const res = await http.post<{ access_token: string; refresh_token?: string; expires_in?: number }>(
        '/oauth/token',
        { grant_type: 'refresh_token', refresh_token: params.refreshToken },
        { headers: { Authorization: `Basic ${basic}` } },
      );
      return {
        accessToken: res.access_token,
        refreshToken: res.refresh_token ?? params.refreshToken,
        expiresAt: res.expires_in ? new Date(Date.now() + res.expires_in * 1000) : undefined,
        scopes: [],
      };
    }
    default:
      throw new ToolError('validation', `${provider} tokens cannot be refreshed`, { retryable: false });
  }
}

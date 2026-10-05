import { ToolError } from '@forgeline/shared';
import { HttpClient } from '../core/http';
import { adfToText, markdownToAdf, type AdfDocument } from './adf';

/**
 * Jira Cloud REST v3 client. Supports OAuth 2.0 (3LO) via
 * api.atlassian.com/ex/jira/{cloudId} and API-token basic auth against the site URL.
 */
export type JiraAuth =
  | { type: 'oauth'; accessToken: string; cloudId: string; apiBaseUrl?: string }
  | { type: 'basic'; email: string; apiToken: string; siteUrl: string };

export interface JiraIssue {
  id: string;
  key: string;
  self: string;
  fields: {
    summary: string;
    description?: unknown;
    status?: { name: string; statusCategory?: { key: string } };
    issuetype?: { name: string };
    priority?: { name: string };
    labels?: string[];
    assignee?: { displayName: string; accountId: string } | null;
    created?: string;
    updated?: string;
    project?: { key: string; name: string };
  };
}

export interface JiraTransition {
  id: string;
  name: string;
  to: { name: string };
}

export class JiraClient {
  readonly http: HttpClient;
  /** Browser URL of the Jira site (for issue links). */
  readonly siteUrl: string;

  constructor(auth: JiraAuth, options: { siteUrl?: string; fetchImpl?: typeof fetch } = {}) {
    if (auth.type === 'oauth') {
      const base = (auth.apiBaseUrl ?? 'https://api.atlassian.com').replace(/\/+$/, '');
      this.http = new HttpClient({
        baseUrl: `${base}/ex/jira/${auth.cloudId}/rest/api/3`,
        provider: 'jira',
        fetchImpl: options.fetchImpl,
        defaultHeaders: { Authorization: `Bearer ${auth.accessToken}` },
      });
      this.siteUrl = (options.siteUrl ?? '').replace(/\/+$/, '');
    } else {
      const basic = Buffer.from(`${auth.email}:${auth.apiToken}`).toString('base64');
      this.http = new HttpClient({
        baseUrl: `${auth.siteUrl.replace(/\/+$/, '')}/rest/api/3`,
        provider: 'jira',
        fetchImpl: options.fetchImpl,
        defaultHeaders: { Authorization: `Basic ${basic}` },
      });
      this.siteUrl = auth.siteUrl.replace(/\/+$/, '');
    }
  }

  browseUrl(key: string): string {
    return `${this.siteUrl}/browse/${key}`;
  }

  myself() {
    return this.http.get<{ accountId: string; displayName: string; emailAddress?: string }>('/myself');
  }

  getProject(keyOrId: string) {
    return this.http.get<{ id: string; key: string; name: string; issueTypes?: { id: string; name: string; subtask: boolean }[] }>(`/project/${encodeURIComponent(keyOrId)}`);
  }

  listProjects() {
    return this.http.get<{ values: { id: string; key: string; name: string }[] }>('/project/search', { query: { maxResults: 100 } });
  }

  async createIssue(params: {
    projectKey: string;
    summary: string;
    descriptionMarkdown?: string;
    issueType?: string;
    labels?: string[];
    priority?: string;
  }): Promise<{ id: string; key: string; url: string }> {
    const fields: Record<string, unknown> = {
      project: { key: params.projectKey },
      summary: params.summary.slice(0, 255),
      issuetype: { name: params.issueType ?? 'Task' },
      labels: (params.labels ?? []).map((l) => l.replace(/\s+/g, '-')),
    };
    if (params.descriptionMarkdown) fields.description = markdownToAdf(params.descriptionMarkdown);
    if (params.priority) fields.priority = { name: params.priority };
    try {
      const res = await this.http.post<{ id: string; key: string }>('/issue', { fields });
      return { ...res, url: this.browseUrl(res.key) };
    } catch (err) {
      // Some projects don't expose priority on the create screen — retry without it.
      if (ToolError.is(err) && err.kind === 'validation' && params.priority && /priority/i.test(err.message)) {
        delete fields.priority;
        const res = await this.http.post<{ id: string; key: string }>('/issue', { fields });
        return { ...res, url: this.browseUrl(res.key) };
      }
      throw err;
    }
  }

  getIssue(key: string) {
    return this.http.get<JiraIssue>(`/issue/${encodeURIComponent(key)}`, {
      query: { fields: 'summary,description,status,issuetype,priority,labels,assignee,created,updated,project' },
    });
  }

  async getIssueAsText(key: string): Promise<{ key: string; summary: string; description: string; status: string; url: string; labels: string[]; type: string }> {
    const issue = await this.getIssue(key);
    return {
      key: issue.key,
      summary: issue.fields.summary,
      description: adfToText(issue.fields.description).trim(),
      status: issue.fields.status?.name ?? 'Unknown',
      type: issue.fields.issuetype?.name ?? 'Task',
      labels: issue.fields.labels ?? [],
      url: this.browseUrl(issue.key),
    };
  }

  async updateIssue(key: string, update: { summary?: string; descriptionMarkdown?: string; labels?: string[] }): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (update.summary) fields.summary = update.summary;
    if (update.descriptionMarkdown) fields.description = markdownToAdf(update.descriptionMarkdown);
    if (update.labels) fields.labels = update.labels;
    await this.http.request(`/issue/${encodeURIComponent(key)}`, { method: 'PUT', body: { fields }, responseType: 'none' });
  }

  /** Enhanced JQL search (/search/jql). */
  async searchIssues(jql: string, maxResults = 25): Promise<JiraIssue[]> {
    const res = await this.http.post<{ issues: JiraIssue[] }>(
      '/search/jql',
      { jql, maxResults, fields: ['summary', 'status', 'issuetype', 'priority', 'labels', 'assignee', 'updated'] },
      { retry: true },
    );
    return res.issues ?? [];
  }

  addComment(key: string, markdown: string) {
    return this.http.post<{ id: string; self: string }>(`/issue/${encodeURIComponent(key)}/comment`, { body: markdownToAdf(markdown) satisfies AdfDocument });
  }

  listComments(key: string) {
    return this.http.get<{ comments: { id: string; body: unknown }[] }>(`/issue/${encodeURIComponent(key)}/comment`, { query: { maxResults: 100 } });
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.http.get<{ transitions: JiraTransition[] }>(`/issue/${encodeURIComponent(key)}/transitions`);
    return res.transitions;
  }

  /** Transition by target status or transition name (case-insensitive). */
  async transitionIssue(key: string, target: string): Promise<{ transitioned: boolean; to: string }> {
    const issue = await this.getIssue(key);
    if (issue.fields.status?.name.toLowerCase() === target.toLowerCase()) return { transitioned: false, to: issue.fields.status.name };
    const transitions = await this.getTransitions(key);
    const t = transitions.find((x) => x.to.name.toLowerCase() === target.toLowerCase() || x.name.toLowerCase() === target.toLowerCase());
    if (!t) {
      throw new ToolError('validation', `No transition to "${target}" from "${issue.fields.status?.name}". Available: ${transitions.map((x) => x.to.name).join(', ')}`, { provider: 'jira', retryable: false });
    }
    await this.http.request(`/issue/${encodeURIComponent(key)}/transitions`, { method: 'POST', body: { transition: { id: t.id } }, responseType: 'none' });
    return { transitioned: true, to: t.to.name };
  }

  /** Attach a text artifact (spec, report) to the issue. */
  async attachText(key: string, filename: string, content: string, contentType = 'text/markdown'): Promise<{ id: string; filename: string }[]> {
    const form = new FormData();
    form.append('file', new Blob([content], { type: contentType }), filename);
    const res = await this.http.request<{ id: string; filename: string }[]>(`/issue/${encodeURIComponent(key)}/attachments`, {
      method: 'POST',
      rawBody: form,
      headers: { 'X-Atlassian-Token': 'no-check' },
    });
    return res.data;
  }

  /** Link an external resource (PR, Notion page, deployment) to the issue. Idempotent by globalId. */
  addRemoteLink(key: string, link: { globalId: string; url: string; title: string; summary?: string; icon?: string }) {
    return this.http.post<{ id: number; self: string }>(`/issue/${encodeURIComponent(key)}/remotelink`, {
      globalId: link.globalId,
      object: { url: link.url, title: link.title, summary: link.summary, ...(link.icon && { icon: { url16x16: link.icon } }) },
    }, { retry: true });
  }

  registerWebhook(url: string, events: string[], jqlFilter: string) {
    return this.http.post<{ webhookRegistrationResult: { createdWebhookId?: number; errors?: string[] }[] }>('/webhook', {
      url,
      webhooks: [{ events, jqlFilter }],
    });
  }
}

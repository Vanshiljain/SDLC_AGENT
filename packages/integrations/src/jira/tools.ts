import { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import { defineTool, idempotencyMarker, type AnySdlcTool, type ToolExecutionContext } from '../core/tool';
import { demoNumber } from '../core/helpers';
import { adfToText } from './adf';

const issueKey = z.string().regex(/^[A-Z][A-Z0-9_]+-\d+$/, 'Expected a Jira issue key like AUTH-142');

function projectKey(input: string | undefined, ctx: ToolExecutionContext): string {
  const key = input ?? ctx.project?.settings.jiraProjectKey ?? ctx.project?.key;
  if (!key) throw new ToolError('not_configured', 'No Jira project key configured for this project', { retryable: false });
  return key;
}

function demoKey(ctx: ToolExecutionContext): string {
  return `${ctx.project?.settings.jiraProjectKey ?? ctx.project?.key ?? 'DEMO'}-${demoNumber(ctx.idempotencyKey, 100, 999)}`;
}

export const jiraCreateIssue = defineTool({
  name: 'jira.createIssue',
  title: 'Create Jira ticket',
  description: 'Create a Jira issue with a Markdown description. Idempotent: retries return the same ticket.',
  category: 'jira',
  provider: 'JIRA',
  agent: 'planning',
  inputSchema: z.object({
    projectKey: z.string().optional(),
    summary: z.string().min(3).max(255),
    description: z.string().max(30_000).default(''),
    issueType: z.string().max(50).optional(),
    labels: z.array(z.string().max(100)).max(20).default([]),
    priority: z.enum(['Highest', 'High', 'Medium', 'Low', 'Lowest']).optional(),
  }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const jira = await ctx.clients.jira();
    const key = projectKey(input.projectKey, ctx);
    const marker = idempotencyMarker(ctx);
    // Find-before-create using the marker label: covers crashes between the API call and the ledger write.
    const existing = await jira.searchIssues(`project = "${key}" AND labels = "${marker}"`, 1);
    let issue: { key: string; id: string; url: string; created: boolean };
    if (existing[0]) {
      issue = { key: existing[0].key, id: existing[0].id, url: jira.browseUrl(existing[0].key), created: false };
    } else {
      const created = await jira.createIssue({
        projectKey: key,
        summary: input.summary,
        descriptionMarkdown: input.description,
        issueType: input.issueType ?? ctx.project?.settings.jiraIssueType ?? 'Task',
        labels: [...input.labels, 'forgeline', marker],
        priority: input.priority,
      });
      issue = { ...created, created: true };
    }
    return {
      output: { key: issue.key, id: issue.id, url: issue.url, summary: input.summary, created: issue.created },
      summary: issue.created ? `Created ${issue.key}: ${input.summary}` : `Found existing ${issue.key} (idempotent retry)`,
      externalResources: [{ provider: 'JIRA', type: 'JIRA_ISSUE', externalId: issue.id, key: issue.key, title: input.summary, url: issue.url, status: 'To Do' }],
    };
  },
  async simulate(input, ctx) {
    const key = demoKey(ctx);
    return {
      simulated: true,
      output: { key, id: `demo-${key}`, url: null, summary: input.summary, created: true },
      summary: `[Simulated] Created ${key}: ${input.summary}`,
      externalResources: [{ provider: 'JIRA', type: 'JIRA_ISSUE', externalId: `demo-${key}-${ctx.idempotencyKey}`, key, title: input.summary, status: 'To Do' }],
    };
  },
});

export const jiraGetIssue = defineTool({
  name: 'jira.getIssue',
  title: 'Get Jira ticket',
  description: 'Read a Jira issue (summary, description, status, labels).',
  category: 'jira',
  provider: 'JIRA',
  inputSchema: z.object({ key: issueKey }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const jira = await ctx.clients.jira();
    const issue = await jira.getIssueAsText(input.key);
    return { output: issue, summary: `${issue.key} [${issue.status}] ${issue.summary}` };
  },
});

export const jiraSearchIssues = defineTool({
  name: 'jira.searchIssues',
  title: 'Search Jira',
  description: 'Search Jira issues with JQL.',
  category: 'jira',
  provider: 'JIRA',
  inputSchema: z.object({ jql: z.string().min(1).max(2000), maxResults: z.number().int().min(1).max(100).default(20) }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const jira = await ctx.clients.jira();
    const issues = await jira.searchIssues(input.jql, input.maxResults);
    const items = issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name ?? null, type: i.fields.issuetype?.name ?? null, url: jira.browseUrl(i.key) }));
    return { output: { items }, summary: `${items.length} issue(s) match` };
  },
});

export const jiraUpdateIssue = defineTool({
  name: 'jira.updateIssue',
  title: 'Update Jira ticket',
  description: 'Update summary, description or labels of a Jira issue.',
  category: 'jira',
  provider: 'JIRA',
  inputSchema: z.object({ key: issueKey, summary: z.string().max(255).optional(), description: z.string().max(30_000).optional(), addLabels: z.array(z.string()).default([]) }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const jira = await ctx.clients.jira();
    let labels: string[] | undefined;
    if (input.addLabels.length) {
      const issue = await jira.getIssue(input.key);
      labels = [...new Set([...(issue.fields.labels ?? []), ...input.addLabels.map((l) => l.replace(/\s+/g, '-'))])];
    }
    await jira.updateIssue(input.key, { summary: input.summary, descriptionMarkdown: input.description, labels });
    return { output: { key: input.key, url: jira.browseUrl(input.key) }, summary: `Updated ${input.key}` };
  },
  async simulate(input) {
    return { simulated: true, output: { key: input.key, url: null }, summary: `[Simulated] Updated ${input.key}` };
  },
});

export const jiraAddComment = defineTool({
  name: 'jira.addComment',
  title: 'Comment on Jira ticket',
  description: 'Add a Markdown comment to a Jira issue (idempotent).',
  category: 'jira',
  provider: 'JIRA',
  inputSchema: z.object({ key: issueKey, body: z.string().min(1).max(30_000) }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const jira = await ctx.clients.jira();
    const marker = idempotencyMarker(ctx);
    const { comments } = await jira.listComments(input.key);
    const dup = comments.find((c) => adfToText(c.body).includes(marker));
    if (dup) return { output: { key: input.key, commentId: dup.id }, summary: `Comment already on ${input.key}` };
    const c = await jira.addComment(input.key, `${input.body}\n\n_Forgeline · ${marker}_`);
    return { output: { key: input.key, commentId: c.id }, summary: `Commented on ${input.key}` };
  },
  async simulate(input) {
    return { simulated: true, output: { key: input.key, commentId: 'demo' }, summary: `[Simulated] Commented on ${input.key}` };
  },
});

export const jiraTransitionIssue = defineTool({
  name: 'jira.transitionIssue',
  title: 'Move Jira ticket',
  description: 'Transition a Jira issue to a status (e.g. "In Progress", "In Review", "Done").',
  category: 'jira',
  provider: 'JIRA',
  inputSchema: z.object({ key: issueKey, status: z.string().min(1).max(100) }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const jira = await ctx.clients.jira();
    const res = await jira.transitionIssue(input.key, input.status);
    return {
      output: { key: input.key, status: res.to, transitioned: res.transitioned },
      summary: res.transitioned ? `Moved ${input.key} → ${res.to}` : `${input.key} already in ${res.to}`,
      externalResources: [],
    };
  },
  async simulate(input) {
    return { simulated: true, output: { key: input.key, status: input.status, transitioned: true }, summary: `[Simulated] Moved ${input.key} → ${input.status}` };
  },
});

export const jiraAttachArtifact = defineTool({
  name: 'jira.attachArtifact',
  title: 'Attach to Jira ticket',
  description: 'Attach a document (spec, report) or link an external resource (PR, page) to a Jira issue.',
  category: 'jira',
  provider: 'JIRA',
  inputSchema: z.object({
    key: issueKey,
    title: z.string().min(1).max(200),
    url: z.string().url().optional(),
    content: z.string().max(2_000_000).optional(),
    filename: z.string().max(200).optional(),
  }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    if (!input.url && !input.content) throw new ToolError('validation', 'Provide url (remote link) or content (attachment)');
    const jira = await ctx.clients.jira();
    if (input.url) {
      await jira.addRemoteLink(input.key, { globalId: `forgeline:${idempotencyMarker(ctx)}`, url: input.url, title: input.title });
      return { output: { key: input.key, linked: input.url as string | null, attached: null as string | null }, summary: `Linked "${input.title}" to ${input.key}` };
    }
    const filename = input.filename ?? `${input.title.replace(/[^\w.-]+/g, '-').toLowerCase()}.md`;
    const issue = await jira.http.get<{ fields: { attachment?: { filename: string }[] } }>(`/issue/${input.key}`, { query: { fields: 'attachment' } });
    if (issue.fields.attachment?.some((a) => a.filename === filename)) {
      return { output: { key: input.key, linked: null, attached: filename }, summary: `${filename} already attached to ${input.key}` };
    }
    await jira.attachText(input.key, filename, input.content!);
    return { output: { key: input.key, linked: null, attached: filename }, summary: `Attached ${filename} to ${input.key}` };
  },
  async simulate(input) {
    return { simulated: true, output: { key: input.key, linked: input.url ?? null, attached: input.filename ?? input.title }, summary: `[Simulated] Attached "${input.title}" to ${input.key}` };
  },
});

export const jiraTools: AnySdlcTool[] = [jiraCreateIssue, jiraGetIssue, jiraSearchIssues, jiraUpdateIssue, jiraAddComment, jiraTransitionIssue, jiraAttachArtifact];

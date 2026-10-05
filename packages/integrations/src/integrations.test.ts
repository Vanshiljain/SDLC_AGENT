import { describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { ToolError } from '@forgeline/shared';
import { HttpClient, parseRetryAfter, redactUrl } from './core/http';
import { GitHubClient } from './github/client';
import { githubCommitFiles, githubCreateBranch, githubCreatePullRequest } from './github/tools';
import { actionsAwaitRuns } from './github-actions/tools';
import { JiraClient } from './jira/client';
import { jiraCreateIssue, jiraTransitionIssue } from './jira/tools';
import { probeUrl } from './http/probes';
import { markdownToAdf, adfToText } from './jira/adf';
import { markdownToBlocks, blocksToMarkdown } from './notion/blocks';
import { verifyGitHubSignature, verifyTimestampedSignature, verifyTrelloSignature } from './webhooks/signatures';
import { isPrivateAddress, safeFetch } from './http/ssrf';
import { HttpDevOpsProvider, signDevOpsRequest } from './devops/http-devops';
import { GitHubActionsCiCdProvider } from './devops/github-actions-cicd';
import { buildAuthorizeUrl } from './oauth/providers';
import { idempotencyMarker } from './core/tool';
import { mockFetch, toolContext } from './test-utils';

describe('HttpClient', () => {
  it('classifies HTTP failures', async () => {
    const cases: [number, string][] = [
      [401, 'auth'],
      [403, 'permission'],
      [404, 'not_found'],
      [409, 'conflict'],
      [422, 'validation'],
    ];
    for (const [status, kind] of cases) {
      const { fetch } = mockFetch([{ method: 'GET', path: /\/x/, handler: () => ({ status, body: { message: 'nope' } }) }]);
      const http = new HttpClient({ baseUrl: 'https://api.test', provider: 'test', fetchImpl: fetch });
      const err = await http.get('/x').catch((e: unknown) => e);
      expect(ToolError.is(err) && err.kind).toBe(kind);
      expect((err as ToolError).retryable).toBe(false);
    }
  });

  it('retries 5xx and rate limits for GET and honours Retry-After', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /\/flaky/,
        handler: ({ calls: n }) =>
          n === 1 ? { status: 503 } : n === 2 ? { status: 429, headers: { 'retry-after': '0' } } : { body: { ok: true } },
      },
    ]);
    const http = new HttpClient({ baseUrl: 'https://api.test', provider: 'test', fetchImpl: fetch });
    await expect(http.get('/flaky')).resolves.toEqual({ ok: true });
    expect(calls).toHaveLength(3);
  });

  it('does not retry non-idempotent POSTs by default', async () => {
    const { fetch, calls } = mockFetch([{ method: 'POST', path: /\/create/, handler: () => ({ status: 502 }) }]);
    const http = new HttpClient({ baseUrl: 'https://api.test', provider: 'test', fetchImpl: fetch });
    await expect(http.post('/create', {})).rejects.toMatchObject({ kind: 'external', retryable: true });
    expect(calls).toHaveLength(1);
  });

  it('flags malformed JSON and times out', async () => {
    const { fetch } = mockFetch([{ method: 'GET', path: /\/bad/, handler: () => ({ text: '{not json' }) }]);
    const http = new HttpClient({ baseUrl: 'https://api.test', provider: 'test', fetchImpl: fetch, maxRetries: 0 });
    await expect(http.get('/bad')).rejects.toMatchObject({ kind: 'malformed_response' });

    const slow = (async (_u: unknown, init?: RequestInit) =>
      new Promise((_, reject) =>
        init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))),
      )) as typeof fetch;
    const http2 = new HttpClient({ baseUrl: 'https://api.test', provider: 'test', fetchImpl: slow, maxRetries: 0 });
    await expect(http2.get('/slow', { timeoutMs: 50 })).rejects.toMatchObject({ kind: 'timeout' });
  });

  it('parses retry headers and redacts secrets in URLs', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '3' }))).toBe(3000);
    const now = Date.now();
    expect(
      parseRetryAfter(new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 10) }), now),
    ).toBeGreaterThan(8000);
    expect(redactUrl('https://api.trello.com/1/cards?key=abc&token=secret&name=x')).not.toMatch(/secret|abc/);
  });
});

describe('GitHub tools', () => {
  it('createBranch is idempotent and supports compensation', async () => {
    let exists = false;
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /\/git\/ref\/heads\/main$/,
        handler: () => ({ body: { ref: 'refs/heads/main', object: { sha: 'a'.repeat(40), type: 'commit' } } }),
      },
      {
        method: 'GET',
        path: /\/git\/ref\/heads\/feature\/x$/,
        handler: () => (exists ? { body: { ref: 'x', object: { sha: 'b'.repeat(40), type: 'commit' } } } : { status: 404 }),
      },
      {
        method: 'POST',
        path: /\/git\/refs$/,
        handler: () => {
          exists = true;
          return { status: 201, body: { ref: 'refs/heads/feature/x', object: { sha: 'a'.repeat(40), type: 'commit' } } };
        },
      },
      { method: 'DELETE', path: /\/git\/refs\/heads\/feature\/x$/, handler: () => ({ status: 204 }) },
    ]);
    const gh = new GitHubClient({ token: 't', fetchImpl: fetch });
    const ctx = toolContext({ clients: { github: async () => gh } });
    const first = await githubCreateBranch.execute({ branch: 'feature/x' }, ctx);
    expect(first.output.created).toBe(true);
    const second = await githubCreateBranch.execute({ branch: 'feature/x' }, ctx);
    expect(second.output.created).toBe(false);
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
    await githubCreateBranch.compensate!({ branch: 'feature/x' }, first.output, ctx);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer t');
  });

  it('refuses to commit to the default branch and skips duplicate commits', async () => {
    const ctx0 = toolContext({ clients: { github: async () => new GitHubClient({ token: 't', fetchImpl: mockFetch([]).fetch }) } });
    await expect(
      githubCommitFiles.execute({ branch: 'main', message: 'x', files: [{ path: 'a.ts', content: '1' }] }, ctx0),
    ).rejects.toMatchObject({ kind: 'permission' });

    const ctx = toolContext({});
    const marker = idempotencyMarker(ctx);
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /\/git\/ref\/heads\/feat$/,
        handler: () => ({ body: { ref: 'x', object: { sha: 'c'.repeat(40), type: 'commit' } } }),
      },
      {
        method: 'GET',
        path: /\/git\/commits\/c+$/,
        handler: () => ({ body: { sha: 'c'.repeat(40), message: `feat: x\n\nForgeline-Ref: ${marker}`, html_url: 'https://gh/commit' } }),
      },
    ]);
    const gh = new GitHubClient({ token: 't', fetchImpl: fetch });
    const res = await githubCommitFiles.execute(
      { branch: 'feat', message: 'feat: x', files: [{ path: 'a.ts', content: '1' }] },
      { ...ctx, clients: { ...ctx.clients, github: async () => gh } },
    );
    expect(res.output.reused).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('commits multiple files through the Git Data API', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /\/git\/ref\/heads\/feat$/,
        handler: () => ({ body: { ref: 'x', object: { sha: 'c'.repeat(40), type: 'commit' } } }),
      },
      {
        method: 'GET',
        path: /\/git\/commits\/c+$/,
        handler: () => ({ body: { sha: 'c'.repeat(40), message: 'previous', html_url: '', tree: { sha: 'tree0' } } }),
      },
      { method: 'POST', path: /\/git\/blobs$/, handler: () => ({ status: 201, body: { sha: 'blob1' } }) },
      { method: 'POST', path: /\/git\/trees$/, handler: () => ({ status: 201, body: { sha: 'tree1' } }) },
      {
        method: 'POST',
        path: /\/git\/commits$/,
        handler: () => ({ status: 201, body: { sha: 'd'.repeat(40), html_url: 'https://gh/c/d' } }),
      },
      { method: 'PATCH', path: /\/git\/refs\/heads\/feat$/, handler: () => ({ body: {} }) },
    ]);
    const gh = new GitHubClient({ token: 't', fetchImpl: fetch });
    const ctx = toolContext({ clients: { github: async () => gh } });
    const res = await githubCommitFiles.execute(
      {
        branch: 'feat',
        message: 'feat: reset',
        files: [
          { path: 'a.ts', content: 'x' },
          { path: 'old.ts', content: null },
        ],
      },
      ctx,
    );
    expect(res.output.sha).toBe('d'.repeat(40));
    const treeCall = calls.find((c) => c.url.endsWith('/git/trees'))!;
    expect((treeCall.body as { tree: { sha: string | null }[] }).tree).toEqual([
      { path: 'a.ts', mode: '100644', type: 'blob', sha: 'blob1' },
      { path: 'old.ts', mode: '100644', type: 'blob', sha: null },
    ]);
    const commitCall = calls.find((c) => c.url.endsWith('/git/commits') && c.method === 'POST')!;
    expect((commitCall.body as { message: string }).message).toContain('Forgeline-Ref: fl-');
  });

  it('createPullRequest reuses an open PR for the head branch', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /\/pulls$/,
        handler: () => ({
          body: [
            {
              id: 1,
              number: 481,
              title: 'Existing',
              state: 'open',
              html_url: 'https://gh/pr/481',
              head: { ref: 'feat', sha: 'h' },
              base: { ref: 'main', sha: 'b' },
            },
          ],
        }),
      },
    ]);
    const gh = new GitHubClient({ token: 't', fetchImpl: fetch });
    const res = await githubCreatePullRequest.execute(
      { head: 'feat', title: 'x', body: '', draft: false },
      toolContext({ clients: { github: async () => gh } }),
    );
    expect(res.output).toMatchObject({ number: 481, created: false });
    expect(calls[0]!.url).toContain('head=acme%3Afeat');
  });
});

describe('GitHub Actions awaitRuns', () => {
  it('polls via continuation until runs complete, then reports failures with logs', async () => {
    let state: 'running' | 'done' = 'running';
    const run = () => ({
      id: 7,
      name: 'CI',
      status: state === 'running' ? 'in_progress' : 'completed',
      conclusion: state === 'running' ? null : 'failure',
      html_url: 'https://gh/run/7',
      head_branch: 'feat',
      head_sha: 'f'.repeat(40),
      event: 'pull_request',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '',
      workflow_id: 1,
    });
    const { fetch } = mockFetch([
      { method: 'GET', path: /\/actions\/runs$/, handler: () => ({ body: { total_count: 1, workflow_runs: [run()] } }) },
      { method: 'GET', path: /\/actions\/runs\/7$/, handler: () => ({ body: run() }) },
      {
        method: 'GET',
        path: /\/actions\/runs\/7\/jobs$/,
        handler: () => ({
          body: {
            total_count: 1,
            jobs: [{ id: 99, name: 'test', status: 'completed', conclusion: 'failure', html_url: 'https://gh/job/99' }],
          },
        }),
      },
      {
        method: 'GET',
        path: /\/actions\/jobs\/99\/logs$/,
        handler: () => ({ text: 'setup\nrunning tests\nFAIL src/auth.spec.ts\n  expected 200 got 500' }),
      },
    ]);
    const gh = new GitHubClient({ token: 't', fetchImpl: fetch });
    const ctx = toolContext({ clients: { github: async () => gh } });
    const first = await actionsAwaitRuns.execute({ ref: 'f'.repeat(40), discoveryTimeoutSeconds: 60 }, ctx);
    expect(first.continuation).toBeDefined();
    state = 'done';
    const second = await actionsAwaitRuns.execute(
      { ref: 'f'.repeat(40), discoveryTimeoutSeconds: 60 },
      { ...ctx, checkpoint: first.continuation!.checkpoint },
    );
    expect(second.continuation).toBeUndefined();
    expect(second.output.conclusion).toBe('failure');
    expect(second.output.failedJobs[0]!.logExcerpt).toContain('FAIL src/auth.spec.ts');
  });
});

describe('GitHub Actions CI/CD provider', () => {
  it('matches the dispatched run by forgeline_ref when the workflow sets run-name', async () => {
    const now = new Date().toISOString();
    const run = (id: number, title: string) => ({
      id,
      name: 'CI',
      display_title: title,
      status: 'queued',
      conclusion: null,
      html_url: `https://gh/run/${id}`,
      head_branch: 'main',
      head_sha: 'a'.repeat(40),
      event: 'workflow_dispatch',
      created_at: now,
      updated_at: now,
      workflow_id: 1,
    });
    const { fetch, calls } = mockFetch([
      { method: 'POST', path: /\/actions\/workflows\/ci\.yml\/dispatches$/, handler: () => ({ status: 204 }) },
      {
        method: 'GET',
        path: /\/actions\/workflows\/ci\.yml\/runs$/,
        // A concurrent dispatch's run is newer and listed first.
        handler: () => ({ body: { total_count: 2, workflow_runs: [run(11, 'CI · run-b'), run(10, 'CI · run-a')] } }),
      },
      { method: 'GET', path: /\/actions\/runs\/10\/jobs$/, handler: () => ({ body: { total_count: 0, jobs: [] } }) },
    ]);
    const provider = new GitHubActionsCiCdProvider(new GitHubClient({ token: 't', fetchImpl: fetch }), { owner: 'acme', repo: 'auth' });
    const pipeline = await provider.startPipeline({ project: 'AUTH', ref: 'main', stages: ['test'], idempotencyKey: 'run-a' });
    expect(pipeline.id).toBe('10');
    expect(calls[0]!.body).toMatchObject({ ref: 'main', inputs: { forgeline_ref: 'run-a', stages: 'test' } });
  });
});

describe('Jira', () => {
  it('createIssue finds an existing ticket by idempotency label instead of duplicating', async () => {
    let created = 0;
    let searchHits: unknown[] = [];
    const { fetch, calls } = mockFetch([
      { method: 'POST', path: /\/search\/jql$/, handler: () => ({ body: { issues: searchHits } }) },
      {
        method: 'POST',
        path: /\/issue$/,
        handler: () => {
          created++;
          searchHits = [{ id: '10001', key: 'AUTH-142', fields: { summary: 'x' } }];
          return { status: 201, body: { id: '10001', key: 'AUTH-142' } };
        },
      },
    ]);
    const jira = new JiraClient(
      { type: 'basic', email: 'a@b.c', apiToken: 'tok', siteUrl: 'https://acme.atlassian.net' },
      { fetchImpl: fetch },
    );
    const ctx = toolContext({ clients: { jira: async () => jira } });
    const input = { summary: 'Implement password reset', description: '## Goal\n- email link', labels: [] };
    const a = await jiraCreateIssue.execute(input, ctx);
    const b = await jiraCreateIssue.execute(input, ctx);
    expect(created).toBe(1);
    expect(a.output).toMatchObject({ key: 'AUTH-142', created: true, url: 'https://acme.atlassian.net/browse/AUTH-142' });
    expect(b.output).toMatchObject({ key: 'AUTH-142', created: false });
    const createBody = calls.find((c) => c.url.endsWith('/issue'))!.body as { fields: { labels: string[]; description: { type: string } } };
    expect(createBody.fields.labels).toContain(idempotencyMarker(ctx));
    expect(createBody.fields.description.type).toBe('doc');
    expect(calls[0]!.headers.get('authorization')).toMatch(/^Basic /);
  });

  it('transitions by status name and is a no-op when already there', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'GET',
        path: /\/issue\/AUTH-1$/,
        handler: () => ({ body: { id: '1', key: 'AUTH-1', fields: { summary: 's', status: { name: 'To Do' } } } }),
      },
      {
        method: 'GET',
        path: /\/transitions$/,
        handler: () => ({ body: { transitions: [{ id: '31', name: 'Start', to: { name: 'In Progress' } }] } }),
      },
      { method: 'POST', path: /\/transitions$/, handler: () => ({ status: 204 }) },
    ]);
    const jira = new JiraClient(
      { type: 'oauth', accessToken: 'x', cloudId: 'cloud' },
      { fetchImpl: fetch, siteUrl: 'https://acme.atlassian.net' },
    );
    const res = await jiraTransitionIssue.execute(
      { key: 'AUTH-1', status: 'in progress' },
      toolContext({ clients: { jira: async () => jira } }),
    );
    expect(res.output.transitioned).toBe(true);
    expect(calls[0]!.url).toContain('/ex/jira/cloud/rest/api/3/issue/AUTH-1');
    await expect(
      jiraTransitionIssue.execute({ key: 'AUTH-1', status: 'Done' }, toolContext({ clients: { jira: async () => jira } })),
    ).rejects.toMatchObject({ kind: 'validation' });
  });

  it('converts markdown to ADF and back', () => {
    const doc = markdownToAdf('# Title\n\nSome **bold** and `code` and [link](https://x.y).\n\n- a\n- b\n\n```ts\nconst x = 1;\n```');
    expect(doc.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'codeBlock']);
    expect(doc.content[1]!.content!.find((n) => n.marks?.[0]?.type === 'strong')!.text).toBe('bold');
    expect(adfToText(doc)).toContain('const x = 1;');
  });
});

describe('Notion blocks', () => {
  it('round-trips common markdown', () => {
    const blocks = markdownToBlocks('# API\n\nIntro **text**.\n\n- one\n1. first\n- [x] done\n\n```ts\nlet a = 1\n```\n\n---\n> quote');
    expect(blocks.map((b) => b.type)).toEqual([
      'heading_1',
      'paragraph',
      'bulleted_list_item',
      'numbered_list_item',
      'to_do',
      'code',
      'divider',
      'quote',
    ]);
    const md = blocksToMarkdown(blocks);
    expect(md).toContain('# API');
    expect(md).toContain('- [x] done');
  });

  it('splits long text into 2000-char rich text chunks', () => {
    const blocks = markdownToBlocks('x'.repeat(5000));
    expect((blocks[0]!.paragraph as { rich_text: unknown[] }).rich_text.length).toBe(3);
  });
});

describe('webhook signatures', () => {
  it('verifies GitHub, Trello and timestamped signatures', () => {
    const body = '{"a":1}';
    const gh = `sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`;
    expect(verifyGitHubSignature('s3cret', body, gh)).toBe(true);
    expect(verifyGitHubSignature('wrong', body, gh)).toBe(false);
    expect(verifyGitHubSignature('s3cret', body, undefined)).toBe(false);

    const trello = createHmac('sha1', 'app')
      .update(body + 'https://cb')
      .digest('base64');
    expect(verifyTrelloSignature('app', body, 'https://cb', trello)).toBe(true);

    const ts = String(Math.floor(Date.now() / 1000));
    expect(verifyTimestampedSignature('k', body, ts, signDevOpsRequest('k', ts, body))).toBe(true);
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifyTimestampedSignature('k', body, old, signDevOpsRequest('k', old, body))).toBe(false);
  });
});

describe('SSRF guard', () => {
  it('detects private addresses', () => {
    for (const ip of [
      '127.0.0.1',
      '10.1.2.3',
      '172.20.0.1',
      '192.168.1.1',
      '169.254.169.254',
      '::1',
      'fd00::1',
      '::ffff:127.0.0.1',
      '100.64.0.1',
    ]) {
      expect(isPrivateAddress(ip)).toBe(true);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) expect(isPrivateAddress(ip)).toBe(false);
  });

  it('blocks private targets and non-http schemes', async () => {
    await expect(safeFetch('http://127.0.0.1:8089/x', {}, { allowPrivateNetworks: false })).rejects.toMatchObject({ kind: 'permission' });
    await expect(safeFetch('http://localhost:8089/x', {}, { allowPrivateNetworks: false })).rejects.toMatchObject({ kind: 'permission' });
    await expect(safeFetch('file:///etc/passwd', {}, { allowPrivateNetworks: true })).rejects.toMatchObject({ kind: 'validation' });
    await expect(safeFetch('http://user:pw@example.com', {}, { allowPrivateNetworks: true })).rejects.toMatchObject({ kind: 'validation' });
  });
});

describe('DevOps provider', () => {
  it('signs requests and sends idempotency keys', async () => {
    const { fetch, calls } = mockFetch([
      {
        method: 'POST',
        path: /\/v1\/deployments$/,
        handler: () => ({ status: 201, body: { id: 'd1', status: 'running', environment: 'staging', version: '1.2.0' } }),
      },
    ]);
    const p = new HttpDevOpsProvider({ baseUrl: 'https://devops.test', apiToken: 'tok', signingSecret: 'sec', fetchImpl: fetch });
    const res = await p.deploy({
      project: 'auth',
      environment: 'staging',
      environmentType: 'STAGING',
      version: '1.2.0',
      idempotencyKey: 'idem-1',
    });
    expect(res.id).toBe('d1');
    const h = calls[0]!.headers;
    expect(h.get('idempotency-key')).toBe('idem-1');
    expect(h.get('authorization')).toBe('Bearer tok');
    const ts = h.get('x-forgeline-timestamp')!;
    expect(h.get('x-forgeline-signature')).toBe(signDevOpsRequest('sec', ts, JSON.stringify(calls[0]!.body)));
  });
});

describe('OAuth', () => {
  it('builds provider authorize URLs with state', () => {
    const gh = new URL(
      buildAuthorizeUrl('GITHUB', { config: { clientId: 'cid', clientSecret: 's' }, redirectUri: 'https://app/cb', state: 'st' }),
    );
    expect(gh.searchParams.get('state')).toBe('st');
    expect(gh.searchParams.get('scope')).toContain('repo');
    const jira = new URL(
      buildAuthorizeUrl('JIRA', { config: { clientId: 'cid', clientSecret: 's' }, redirectUri: 'https://app/cb', state: 'st' }),
    );
    expect(jira.searchParams.get('audience')).toBe('api.atlassian.com');
    expect(jira.searchParams.get('scope')).toContain('offline_access');
  });
});

describe('probe URLs', () => {
  it('keeps the environment base path', () => {
    expect(probeUrl('https://example.com/app', '/health')).toBe('https://example.com/app/health');
    expect(probeUrl('https://example.com/app/', 'login')).toBe('https://example.com/app/login');
    expect(probeUrl('https://example.com', '/api/status?x=1')).toBe('https://example.com/api/status?x=1');
  });
});

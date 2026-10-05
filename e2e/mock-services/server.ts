import { createHash, createHmac, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as tar from 'tar';
import { embed, respond, resetLlm, usage, type ChatRequest } from './llm';
import { INITIAL_REPO } from './repo-fixture';

/**
 * Mock external systems for end-to-end tests. Behaves like the real APIs at
 * the level Forgeline uses them (status codes, pagination-free shapes,
 * idempotency-relevant semantics) and exposes /__state for assertions.
 * TEST INFRASTRUCTURE ONLY — never used by the product at runtime.
 */

type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: string[]; query: URLSearchParams; body: unknown; raw: Buffer }) => unknown;

interface Commit {
  sha: string;
  treeSha: string;
  parents: string[];
  message: string;
}

export interface MockState {
  github: {
    owner: string;
    repo: string;
    blobs: Map<string, string>;
    trees: Map<string, Map<string, string>>;
    commits: Map<string, Commit>;
    refs: Map<string, string>;
    pulls: { number: number; title: string; body: string; head: string; base: string; state: 'open' | 'closed'; merged: boolean; mergeSha?: string }[];
    reviews: { pull: number; id: number; body: string; event: string; comments: number }[];
    comments: { issue: number; id: number; body: string }[];
    runs: { id: number; headSha: string; branch: string; polls: number; conclusion: 'success' | 'failure' }[];
  };
  jira: { issues: { id: string; key: string; summary: string; description: unknown; labels: string[]; status: string; comments: { id: string; body: unknown }[]; links: string[]; attachments: string[] }[] };
  notion: { pages: { id: string; title: string; blocks: unknown[]; archived: boolean; parent: unknown }[] };
  devops: { pipelines: { id: string; polls: number; stages: string[] }[]; deployments: { id: string; environment: string; version: string; polls: number; rollback: boolean }[]; signatureFailures: number };
  slack: { messages: unknown[] };
  envHits: Record<string, number>;
  llm: { chatCalls: number; embeddingCalls: number };
}

export const DEVOPS_SIGNING_SECRET = 'e2e-devops-signing-secret-0123456789';

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

function newState(owner = 'acme', repo = 'auth-service'): MockState {
  const blobs = new Map<string, string>();
  const tree = new Map<string, string>();
  for (const [path, content] of Object.entries(INITIAL_REPO)) {
    const b = sha1(`blob:${content}`);
    blobs.set(b, content);
    tree.set(path, b);
  }
  const treeSha = sha1(`tree:${[...tree.entries()].join('|')}`);
  const commit: Commit = { sha: sha1('initial'), treeSha, parents: [], message: 'Initial commit' };
  return {
    github: { owner, repo, blobs, trees: new Map([[treeSha, tree]]), commits: new Map([[commit.sha, commit]]), refs: new Map([['heads/main', commit.sha]]), pulls: [], reviews: [], comments: [], runs: [] },
    jira: { issues: [] },
    notion: { pages: [] },
    devops: { pipelines: [], deployments: [], signatureFailures: 0 },
    slack: { messages: [] },
    envHits: {},
    llm: { chatCalls: 0, embeddingCalls: 0 },
  };
}

function send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) {
  const payload = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/plain' : Buffer.isBuffer(body) ? 'application/gzip' : 'application/json', ...headers });
  res.end(payload);
}

export interface MockServices {
  url: string;
  state: MockState;
  close(): Promise<void>;
  reset(): void;
}

export async function startMockServices(port = 0): Promise<MockServices> {
  let state = newState();
  const routes: { method: string; re: RegExp; handler: Handler }[] = [];
  const on = (method: string, pattern: string, handler: Handler) => {
    const re = new RegExp(`^${pattern.replace(/:rest/g, '(.+)').replace(/:(\w+)/g, '([^/]+)')}$`);
    routes.push({ method, re, handler });
  };

  // ───────────── GitHub ─────────────
  const gh = () => state.github;
  const treeOf = (sha: string) => gh().trees.get(gh().commits.get(sha)!.treeSha)!;
  const contentAt = (ref: string): Map<string, string> => {
    const sha = gh().refs.get(`heads/${ref}`) ?? (gh().commits.has(ref) ? ref : undefined);
    if (!sha) throw new Error('ref not found');
    const t = treeOf(sha);
    return new Map([...t.entries()].map(([p, b]) => [p, gh().blobs.get(b)!]));
  };
  const repoBase = '/github/repos/:owner/:repo';
  const ensureRepo = (params: string[], res: ServerResponse) => {
    if (params[0] !== gh().owner || params[1] !== gh().repo) {
      send(res, 404, { message: 'Not Found' });
      return false;
    }
    return true;
  };
  const commitUrl = (sha: string) => `https://github.mock/${gh().owner}/${gh().repo}/commit/${sha}`;
  const pullJson = (p: MockState['github']['pulls'][number]) => ({
    id: p.number * 1000,
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    merged: p.merged,
    html_url: `https://github.mock/${gh().owner}/${gh().repo}/pull/${p.number}`,
    head: { ref: p.head, sha: gh().refs.get(`heads/${p.head}`) ?? '' },
    base: { ref: p.base, sha: gh().refs.get(`heads/${p.base}`) ?? '' },
    user: { login: 'forgeline-bot' },
  });
  const diffBetween = (base: Map<string, string>, head: Map<string, string>) => {
    const out: string[] = [];
    const files: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
    for (const path of new Set([...base.keys(), ...head.keys()])) {
      const a = base.get(path);
      const b = head.get(path);
      if (a === b) continue;
      const aLines = a ? a.split('\n') : [];
      const bLines = b ? b.split('\n') : [];
      out.push(`diff --git a/${path} b/${path}`, `--- ${a ? `a/${path}` : '/dev/null'}`, `+++ ${b ? `b/${path}` : '/dev/null'}`, `@@ -${a ? 1 : 0},${aLines.length} +${b ? 1 : 0},${bLines.length} @@`, ...aLines.map((l) => `-${l}`), ...bLines.map((l) => `+${l}`));
      files.push({ filename: path, status: !a ? 'added' : !b ? 'removed' : 'modified', additions: bLines.length, deletions: aLines.length, changes: aLines.length + bLines.length });
    }
    return { diff: out.join('\n'), files };
  };

  on('GET', '/github/user', ({ res }) => send(res, 200, { id: 42, login: 'forgeline-bot', name: 'Forgeline Bot' }, { 'x-oauth-scopes': 'repo, workflow, read:user' }));
  on('GET', '/github/rate_limit', ({ res }) => send(res, 200, { rate: { remaining: 4999 } }, { 'x-ratelimit-remaining': '4999' }));
  on('GET', '/github/user/repos', ({ res }) => send(res, 200, [{ id: 1, name: gh().repo, full_name: `${gh().owner}/${gh().repo}`, private: true, default_branch: 'main', html_url: `https://github.mock/${gh().owner}/${gh().repo}`, owner: { login: gh().owner }, language: 'JavaScript' }]));
  on('GET', repoBase, ({ res, params }) => ensureRepo(params, res) && send(res, 200, { id: 1, name: gh().repo, full_name: `${gh().owner}/${gh().repo}`, private: true, default_branch: 'main', html_url: `https://github.mock/${gh().owner}/${gh().repo}`, owner: { login: gh().owner }, language: 'JavaScript' }));
  on('GET', `${repoBase}/git/ref/:rest`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const sha = gh().refs.get(params[2]!);
    if (!sha) return send(res, 404, { message: 'Not Found' });
    send(res, 200, { ref: `refs/${params[2]}`, object: { sha, type: 'commit' } });
  });
  on('POST', `${repoBase}/git/refs`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const b = body as { ref: string; sha: string };
    const name = b.ref.replace(/^refs\//, '');
    if (gh().refs.has(name)) return send(res, 422, { message: 'Reference already exists' });
    gh().refs.set(name, b.sha);
    send(res, 201, { ref: b.ref, object: { sha: b.sha, type: 'commit' } });
  });
  on('PATCH', `${repoBase}/git/refs/:rest`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    gh().refs.set(params[2]!, (body as { sha: string }).sha);
    const sha = (body as { sha: string }).sha;
    const branch = params[2]!.replace(/^heads\//, '');
    // A push to a non-default branch starts CI (fails once if the tree has no expiry check, which never happens after repair).
    if (branch !== 'main') gh().runs.push({ id: 7000 + gh().runs.length, headSha: sha, branch, polls: 0, conclusion: 'success' });
    send(res, 200, { ref: `refs/${params[2]}`, object: { sha } });
  });
  on('DELETE', `${repoBase}/git/refs/:rest`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    if (!gh().refs.delete(params[2]!)) return send(res, 422, { message: 'Reference does not exist' });
    send(res, 204);
  });
  on('GET', `${repoBase}/git/commits/:sha`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const c = gh().commits.get(params[2]!);
    if (!c) return send(res, 404, { message: 'Not Found' });
    send(res, 200, { sha: c.sha, message: c.message, html_url: commitUrl(c.sha), tree: { sha: c.treeSha }, parents: c.parents.map((sha) => ({ sha })) });
  });
  on('POST', `${repoBase}/git/blobs`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const content = Buffer.from((body as { content: string }).content, 'base64').toString('utf8');
    const sha = sha1(`blob:${content}`);
    gh().blobs.set(sha, content);
    send(res, 201, { sha });
  });
  on('GET', `${repoBase}/git/blobs/:sha`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const c = gh().blobs.get(params[2]!);
    if (c === undefined) return send(res, 404, { message: 'Not Found' });
    send(res, 200, { content: Buffer.from(c).toString('base64'), encoding: 'base64' });
  });
  on('POST', `${repoBase}/git/trees`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const b = body as { base_tree: string; tree: { path: string; sha: string | null }[] };
    const tree = new Map(gh().trees.get(b.base_tree) ?? []);
    for (const e of b.tree) {
      if (e.sha === null) tree.delete(e.path);
      else tree.set(e.path, e.sha);
    }
    const sha = sha1(`tree:${[...tree.entries()].sort().join('|')}`);
    gh().trees.set(sha, tree);
    send(res, 201, { sha });
  });
  on('GET', `${repoBase}/git/trees/:sha`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const commit = gh().commits.get(params[2]!);
    const tree = gh().trees.get(commit ? commit.treeSha : params[2]!);
    if (!tree) return send(res, 404, { message: 'Not Found' });
    send(res, 200, { tree: [...tree.entries()].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: gh().blobs.get(sha)!.length })), truncated: false });
  });
  on('POST', `${repoBase}/git/commits`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const b = body as { message: string; tree: string; parents: string[] };
    const c: Commit = { sha: sha1(`commit:${b.tree}:${b.parents.join(',')}:${b.message}:${randomUUID()}`), treeSha: b.tree, parents: b.parents, message: b.message };
    gh().commits.set(c.sha, c);
    send(res, 201, { sha: c.sha, html_url: commitUrl(c.sha) });
  });
  on('GET', `${repoBase}/contents/:rest`, ({ res, params, query }) => {
    if (!ensureRepo(params, res)) return;
    try {
      const files = contentAt(query.get('ref') ?? 'main');
      const c = files.get(decodeURIComponent(params[2]!));
      if (c === undefined) return send(res, 404, { message: 'Not Found' });
      send(res, 200, { type: 'file', content: Buffer.from(c).toString('base64'), encoding: 'base64', sha: sha1(`blob:${c}`) });
    } catch {
      send(res, 404, { message: 'Not Found' });
    }
  });
  on('GET', `${repoBase}/tarball/:rest`, async ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    let files: Map<string, string>;
    try {
      files = contentAt(decodeURIComponent(params[2]!));
    } catch {
      return send(res, 404, { message: 'Not Found' });
    }
    const dir = await mkdtemp(join(tmpdir(), 'mock-tar-'));
    const top = `${gh().owner}-${gh().repo}-abc123`;
    for (const [p, c] of files) {
      await mkdir(dirname(join(dir, top, p)), { recursive: true });
      await writeFile(join(dir, top, p), c);
    }
    const out = join(dir, 'repo.tar.gz');
    await tar.c({ gzip: true, cwd: dir, file: out }, [top]);
    const data = await readFile(out);
    await rm(dir, { recursive: true, force: true });
    send(res, 200, data);
  });
  on('GET', `${repoBase}/pulls`, ({ res, params, query }) => {
    if (!ensureRepo(params, res)) return;
    const head = query.get('head')?.split(':').pop();
    const st = query.get('state') ?? 'open';
    send(res, 200, gh().pulls.filter((p) => (st === 'all' || p.state === st) && (!head || p.head === head)).map(pullJson));
  });
  on('POST', `${repoBase}/pulls`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const b = body as { title: string; body: string; head: string; base: string };
    if (!gh().refs.has(`heads/${b.head}`)) return send(res, 422, { message: 'head branch not found' });
    const p = { number: 100 + gh().pulls.length + 1, title: b.title, body: b.body, head: b.head, base: b.base, state: 'open' as const, merged: false };
    gh().pulls.push(p);
    send(res, 201, pullJson(p));
  });
  const findPull = (n: string) => gh().pulls.find((p) => p.number === Number(n));
  on('GET', `${repoBase}/pulls/:n`, ({ req, res, params }) => {
    if (!ensureRepo(params, res)) return;
    const p = findPull(params[2]!);
    if (!p) return send(res, 404, { message: 'Not Found' });
    if ((req.headers.accept ?? '').includes('diff')) return send(res, 200, diffBetween(contentAt(p.base), contentAt(p.head)).diff);
    send(res, 200, pullJson(p));
  });
  on('PATCH', `${repoBase}/pulls/:n`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const p = findPull(params[2]!);
    if (!p) return send(res, 404, { message: 'Not Found' });
    Object.assign(p, body as object);
    send(res, 200, pullJson(p));
  });
  on('GET', `${repoBase}/pulls/:n/files`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const p = findPull(params[2]!);
    if (!p) return send(res, 404, { message: 'Not Found' });
    send(res, 200, diffBetween(contentAt(p.base), contentAt(p.head)).files);
  });
  on('PUT', `${repoBase}/pulls/:n/merge`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const p = findPull(params[2]!);
    if (!p) return send(res, 404, { message: 'Not Found' });
    if (p.merged) return send(res, 405, { message: 'Pull Request is not mergeable' });
    const headSha = gh().refs.get(`heads/${p.head}`)!;
    const c: Commit = { sha: sha1(`merge:${headSha}:${randomUUID()}`), treeSha: gh().commits.get(headSha)!.treeSha, parents: [gh().refs.get(`heads/${p.base}`)!, headSha], message: `${p.title} (#${p.number})` };
    gh().commits.set(c.sha, c);
    gh().refs.set(`heads/${p.base}`, c.sha);
    p.merged = true;
    p.state = 'closed';
    p.mergeSha = c.sha;
    send(res, 200, { merged: true, sha: c.sha, message: 'Pull Request successfully merged' });
  });
  on('GET', `${repoBase}/pulls/:n/reviews`, ({ res, params }) => ensureRepo(params, res) && send(res, 200, gh().reviews.filter((r) => r.pull === Number(params[2])).map((r) => ({ id: r.id, body: r.body, state: 'COMMENTED', user: { login: 'forgeline-bot' } }))));
  on('POST', `${repoBase}/pulls/:n/reviews`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const b = body as { body: string; event: string; comments?: unknown[] };
    const r = { pull: Number(params[2]), id: 5000 + gh().reviews.length, body: b.body, event: b.event, comments: b.comments?.length ?? 0 };
    gh().reviews.push(r);
    send(res, 200, { id: r.id, html_url: `https://github.mock/${gh().owner}/${gh().repo}/pull/${r.pull}#review-${r.id}`, state: 'COMMENTED' });
  });
  on('GET', `${repoBase}/issues/:n/comments`, ({ res, params }) => ensureRepo(params, res) && send(res, 200, gh().comments.filter((c) => c.issue === Number(params[2])).map((c) => ({ id: c.id, body: c.body, html_url: `https://github.mock/c/${c.id}` }))));
  on('POST', `${repoBase}/issues/:n/comments`, ({ res, params, body }) => {
    if (!ensureRepo(params, res)) return;
    const c = { issue: Number(params[2]), id: 9000 + gh().comments.length, body: (body as { body: string }).body };
    gh().comments.push(c);
    send(res, 201, { id: c.id, html_url: `https://github.mock/c/${c.id}` });
  });
  const runJson = (r: MockState['github']['runs'][number]) => ({
    id: r.id,
    name: 'CI',
    display_title: 'CI',
    status: r.polls >= 2 ? 'completed' : 'in_progress',
    conclusion: r.polls >= 2 ? r.conclusion : null,
    html_url: `https://github.mock/${gh().owner}/${gh().repo}/actions/runs/${r.id}`,
    head_branch: r.branch,
    head_sha: r.headSha,
    event: 'push',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    workflow_id: 1,
  });
  on('GET', `${repoBase}/actions/runs`, ({ res, params, query }) => {
    if (!ensureRepo(params, res)) return;
    const sha = query.get('head_sha');
    const branch = query.get('branch');
    const runs = gh().runs.filter((r) => (!sha || r.headSha === sha) && (!branch || r.branch === branch));
    runs.forEach((r) => r.polls++);
    send(res, 200, { total_count: runs.length, workflow_runs: runs.map(runJson) });
  });
  on('GET', `${repoBase}/actions/runs/:id`, ({ res, params }) => {
    if (!ensureRepo(params, res)) return;
    const r = gh().runs.find((x) => x.id === Number(params[2]));
    if (!r) return send(res, 404, { message: 'Not Found' });
    r.polls++;
    send(res, 200, runJson(r));
  });
  on('GET', `${repoBase}/actions/runs/:id/jobs`, ({ res, params }) => ensureRepo(params, res) && send(res, 200, { total_count: 1, jobs: [{ id: Number(params[2]) * 10, name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.mock/job' }] }));
  on('GET', `${repoBase}/actions/workflows`, ({ res, params }) => ensureRepo(params, res) && send(res, 200, { workflows: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', state: 'active' }, { id: 2, name: 'Deploy', path: '.github/workflows/deploy.yml', state: 'active' }] }));
  on('GET', `${repoBase}/environments`, ({ res, params }) => ensureRepo(params, res) && send(res, 200, { environments: [] }));

  // ───────────── Jira ─────────────
  const jiraBase = '/jira/rest/api/3';
  const issueJson = (i: MockState['jira']['issues'][number]) => ({ id: i.id, key: i.key, self: `${jiraBase}/issue/${i.id}`, fields: { summary: i.summary, description: i.description, status: { name: i.status }, issuetype: { name: 'Story' }, labels: i.labels, project: { key: i.key.split('-')[0], name: 'Auth' } } });
  on('GET', `${jiraBase}/myself`, ({ res }) => send(res, 200, { accountId: 'acc-1', displayName: 'Forgeline Bot', emailAddress: 'bot@acme.test' }));
  on('POST', `${jiraBase}/search/jql`, ({ res, body }) => {
    const jql = String((body as { jql: string }).jql);
    const label = /labels = "([^"]+)"/.exec(jql)?.[1];
    send(res, 200, { issues: state.jira.issues.filter((i) => !label || i.labels.includes(label)).map(issueJson) });
  });
  on('POST', `${jiraBase}/issue`, ({ res, body }) => {
    const f = (body as { fields: { project: { key: string }; summary: string; description?: unknown; labels?: string[] } }).fields;
    const i = { id: String(10000 + state.jira.issues.length), key: `${f.project.key}-${142 + state.jira.issues.length}`, summary: f.summary, description: f.description ?? null, labels: f.labels ?? [], status: 'To Do', comments: [], links: [], attachments: [] };
    state.jira.issues.push(i);
    send(res, 201, { id: i.id, key: i.key });
  });
  const findIssue = (k: string) => state.jira.issues.find((i) => i.key === k || i.id === k);
  on('GET', `${jiraBase}/issue/:key`, ({ res, params }) => {
    const i = findIssue(params[0]!);
    if (!i) return send(res, 404, { errorMessages: ['Issue does not exist'] });
    send(res, 200, { ...issueJson(i), fields: { ...issueJson(i).fields, attachment: i.attachments.map((filename) => ({ filename })) } });
  });
  on('PUT', `${jiraBase}/issue/:key`, ({ res, params, body }) => {
    const i = findIssue(params[0]!);
    if (!i) return send(res, 404, {});
    const f = (body as { fields: { summary?: string; labels?: string[] } }).fields;
    if (f.summary) i.summary = f.summary;
    if (f.labels) i.labels = f.labels;
    send(res, 204);
  });
  on('GET', `${jiraBase}/issue/:key/comment`, ({ res, params }) => send(res, 200, { comments: findIssue(params[0]!)?.comments ?? [] }));
  on('POST', `${jiraBase}/issue/:key/comment`, ({ res, params, body }) => {
    const i = findIssue(params[0]!);
    if (!i) return send(res, 404, {});
    const c = { id: String(i.comments.length + 1), body: (body as { body: unknown }).body };
    i.comments.push(c);
    send(res, 201, { id: c.id, self: 'x' });
  });
  const WORKFLOW = ['To Do', 'In Progress', 'In Review', 'Done'];
  on('GET', `${jiraBase}/issue/:key/transitions`, ({ res, params }) => {
    const i = findIssue(params[0]!);
    send(res, 200, { transitions: WORKFLOW.filter((s) => s !== i?.status).map((s, idx) => ({ id: String(11 + idx), name: s, to: { name: s } })) });
  });
  on('POST', `${jiraBase}/issue/:key/transitions`, ({ res, params, body }) => {
    const i = findIssue(params[0]!);
    if (!i) return send(res, 404, {});
    const id = (body as { transition: { id: string } }).transition.id;
    const target = WORKFLOW.filter((s) => s !== i.status)[Number(id) - 11];
    if (target) i.status = target;
    send(res, 204);
  });
  on('POST', `${jiraBase}/issue/:key/remotelink`, ({ res, params, body }) => {
    findIssue(params[0]!)?.links.push(JSON.stringify(body));
    send(res, 201, { id: 1, self: 'x' });
  });

  // ───────────── Notion ─────────────
  const notionBase = '/notion/v1';
  const pageJson = (p: MockState['notion']['pages'][number]) => ({ object: 'page', id: p.id, url: `https://notion.mock/${p.id}`, archived: p.archived, properties: { title: { type: 'title', title: [{ plain_text: p.title }] } } });
  on('GET', `${notionBase}/users/me`, ({ res }) => send(res, 200, { id: 'bot-1', name: 'Forgeline', bot: { workspace_name: 'Acme Docs' } }));
  on('POST', `${notionBase}/search`, ({ res, body }) => {
    const q = String((body as { query?: string }).query ?? '').toLowerCase();
    send(res, 200, { results: state.notion.pages.filter((p) => p.title.toLowerCase().includes(q)).map(pageJson) });
  });
  on('POST', `${notionBase}/pages`, ({ res, body }) => {
    const b = body as { parent: unknown; properties: Record<string, { title: { text: { content: string } }[] }>; children?: unknown[] };
    const titleProp = Object.values(b.properties)[0]!;
    const p = { id: randomUUID(), title: titleProp.title.map((t) => t.text.content).join(''), blocks: (b.children ?? []).map((c) => ({ ...(c as object), id: randomUUID() })), archived: false, parent: b.parent };
    state.notion.pages.push(p);
    send(res, 200, pageJson(p));
  });
  on('GET', `${notionBase}/pages/:id`, ({ res, params }) => {
    const p = state.notion.pages.find((x) => x.id === params[0]);
    if (!p) return send(res, 404, { object: 'error', message: 'Could not find page' });
    send(res, 200, pageJson(p));
  });
  on('PATCH', `${notionBase}/pages/:id`, ({ res, params, body }) => {
    const p = state.notion.pages.find((x) => x.id === params[0]);
    if (!p) return send(res, 404, {});
    if ((body as { archived?: boolean }).archived) p.archived = true;
    send(res, 200, pageJson(p));
  });
  on('GET', `${notionBase}/blocks/:id/children`, ({ res, params }) => send(res, 200, { results: state.notion.pages.find((x) => x.id === params[0])?.blocks ?? [], has_more: false, next_cursor: null }));
  on('PATCH', `${notionBase}/blocks/:id/children`, ({ res, params, body }) => {
    const p = state.notion.pages.find((x) => x.id === params[0]);
    if (!p) return send(res, 404, {});
    p.blocks.push(...((body as { children: unknown[] }).children ?? []).map((c) => ({ ...(c as object), id: randomUUID() })));
    send(res, 200, { results: [] });
  });

  // ───────────── DevOps CI/CD ─────────────
  const verifyDevOps = (req: IncomingMessage, raw: Buffer): boolean => {
    const ts = String(req.headers['x-forgeline-timestamp'] ?? '');
    const sig = String(req.headers['x-forgeline-signature'] ?? '');
    const expected = `v1=${createHmac('sha256', DEVOPS_SIGNING_SECRET).update(`${ts}.${raw.toString('utf8')}`).digest('hex')}`;
    const ok = sig === expected && req.headers.authorization === 'Bearer e2e-devops-token';
    if (!ok) state.devops.signatureFailures++;
    return ok;
  };
  on('GET', '/devops/v1/health', ({ res }) => send(res, 200, { status: 'ok', version: '2.4.0' }));
  on('POST', '/devops/v1/pipelines', ({ req, res, raw, body }) => {
    if (!verifyDevOps(req, raw)) return send(res, 401, { message: 'bad signature' });
    const p = { id: `pl-${state.devops.pipelines.length + 1}`, polls: 0, stages: (body as { stages: string[] }).stages };
    state.devops.pipelines.push(p);
    send(res, 201, { id: p.id, status: 'running', url: `https://devops.mock/pipelines/${p.id}`, stages: p.stages.map((s) => ({ stage: s, status: 'queued' })) });
  });
  on('GET', '/devops/v1/pipelines/:id', ({ res, params }) => {
    const p = state.devops.pipelines.find((x) => x.id === params[0]);
    if (!p) return send(res, 404, {});
    p.polls++;
    const done = p.polls >= 2;
    send(res, 200, { id: p.id, status: done ? 'succeeded' : 'running', url: `https://devops.mock/pipelines/${p.id}`, stages: p.stages.map((s) => ({ stage: s, status: done ? 'succeeded' : 'running' })), artifact: done ? { ref: `registry.mock/auth:${p.id}` } : null });
  });
  on('POST', '/devops/v1/deployments', ({ req, res, raw, body }) => {
    if (!verifyDevOps(req, raw)) return send(res, 401, { message: 'bad signature' });
    const b = body as { environment: string; version: string; idempotencyKey: string };
    const existing = state.devops.deployments.find((d) => d.id === `dep-${createHash('md5').update(b.idempotencyKey).digest('hex').slice(0, 8)}`);
    if (existing) return send(res, 200, { id: existing.id, status: 'running', environment: existing.environment, version: existing.version });
    const d = { id: `dep-${createHash('md5').update(b.idempotencyKey).digest('hex').slice(0, 8)}`, environment: b.environment, version: b.version, polls: 0, rollback: false };
    state.devops.deployments.push(d);
    send(res, 201, { id: d.id, status: 'running', environment: d.environment, version: d.version, url: `https://devops.mock/deployments/${d.id}` });
  });
  on('GET', '/devops/v1/deployments/:id', ({ res, params }) => {
    const d = state.devops.deployments.find((x) => x.id === params[0]);
    if (!d) return send(res, 404, {});
    d.polls++;
    send(res, 200, { id: d.id, status: d.polls >= 2 ? 'succeeded' : 'running', environment: d.environment, version: d.version, url: `https://devops.mock/deployments/${d.id}`, message: d.polls >= 2 ? 'Rollout complete' : 'Rolling out' });
  });
  on('POST', '/devops/v1/deployments/:id/rollback', ({ req, res, raw, params }) => {
    if (!verifyDevOps(req, raw)) return send(res, 401, { message: 'bad signature' });
    const src = state.devops.deployments.find((x) => x.id === params[0]);
    const d = { id: `rb-${state.devops.deployments.length}`, environment: src?.environment ?? 'unknown', version: 'previous', polls: 0, rollback: true };
    state.devops.deployments.push(d);
    send(res, 201, { id: d.id, status: 'running', environment: d.environment, version: d.version });
  });
  on('GET', '/devops/v1/environments', ({ res }) => send(res, 200, { environments: [{ name: 'staging', type: 'STAGING' }, { name: 'production', type: 'PRODUCTION' }] }));

  // ───────────── Deployed environments (health + smoke) ─────────────
  on('GET', '/env/:name/:rest', ({ res, params }) => {
    const key = `${params[0]}/${params[1]}`;
    state.envHits[key] = (state.envHits[key] ?? 0) + 1;
    send(res, 200, { status: 'ok', environment: params[0] });
  });

  // ───────────── Slack ─────────────
  on('POST', '/slack/:rest', ({ res, body }) => {
    state.slack.messages.push(body);
    send(res, 200, 'ok');
  });

  // ───────────── OpenAI-compatible LLM ─────────────
  on('POST', '/openai/v1/embeddings', ({ res, body }) => {
    state.llm.embeddingCalls++;
    const b = body as { input: string | string[]; dimensions?: number };
    const inputs = Array.isArray(b.input) ? b.input : [b.input];
    send(res, 200, { object: 'list', data: inputs.map((t, index) => ({ object: 'embedding', index, embedding: embed(String(t), b.dimensions ?? 1536) })), model: 'mock-embedding', usage: { prompt_tokens: 10, total_tokens: 10 } });
  });
  on('POST', '/openai/v1/chat/completions', ({ res, body }) => {
    state.llm.chatCalls++;
    const req = body as ChatRequest;
    const out = respond(req);
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    if (!req.stream) {
      return send(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: req.model,
        choices: [{ index: 0, finish_reason: out.toolCalls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: out.content, ...(out.toolCalls && { tool_calls: out.toolCalls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) }) } }],
        usage: usage(),
      });
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (delta: unknown, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: req.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' });
    if (out.toolCalls) {
      out.toolCalls.forEach((t, index) => chunk({ tool_calls: [{ index, id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } }] }));
      chunk({}, 'tool_calls');
    } else {
      for (const word of (out.content ?? '').split(/(?<= )/)) chunk({ content: word });
      chunk({}, 'stop');
    }
    res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: req.model, choices: [], usage: usage() })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });

  // ───────────── Inspection ─────────────
  on('GET', '/__state', ({ res }) =>
    send(res, 200, {
      github: { refs: Object.fromEntries(gh().refs), pulls: gh().pulls, reviews: gh().reviews, comments: gh().comments.length, runs: gh().runs.length, mainFiles: [...contentAt('main').keys()] },
      jira: state.jira.issues.map((i) => ({ key: i.key, status: i.status, comments: i.comments.length, labels: i.labels })),
      notion: state.notion.pages.map((p) => ({ id: p.id, title: p.title, blocks: p.blocks.length })),
      devops: { pipelines: state.devops.pipelines.length, deployments: state.devops.deployments.map((d) => ({ environment: d.environment, version: d.version, rollback: d.rollback })), signatureFailures: state.devops.signatureFailures },
      slack: state.slack.messages.length,
      envHits: state.envHits,
      llm: state.llm,
    }),
  );
  on('POST', '/__reset', ({ res }) => {
    state = newState();
    resetLlm();
    send(res, 204);
  });

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      void (async () => {
        const raw = Buffer.concat(chunks);
        const url = new URL(req.url ?? '/', 'http://mock');
        let body: unknown = undefined;
        if (raw.length) {
          try {
            body = JSON.parse(raw.toString('utf8'));
          } catch {
            body = raw.toString('utf8');
          }
        }
        const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
        if (!route) return send(res, 404, { message: `mock: no route for ${req.method} ${url.pathname}` });
        const params = route.re.exec(url.pathname)!.slice(1).map((p) => decodeURIComponent(p));
        try {
          await route.handler({ req, res, params, query: url.searchParams, body, raw });
        } catch (err) {
          if (!res.headersSent) send(res, 500, { message: (err as Error).message });
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${address.port}`,
    get state() {
      return state;
    },
    reset: () => {
      state = newState();
      resetLlm();
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (require.main === module) {
  const port = Number(process.env.MOCK_PORT ?? 4010);
  void startMockServices(port).then((m) => console.log(`Mock external services listening on ${m.url}`));
}

import { ToolError } from '@forgeline/shared';
import { HttpClient } from '../core/http';

/** GitHub REST API client (github.com or GitHub Enterprise via apiUrl). */

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface GhUser {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string;
  html_url?: string;
}
export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  language?: string | null;
  description?: string | null;
  owner: { login: string };
  pushed_at?: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
}
export interface GhRef {
  ref: string;
  object: { sha: string; type: string };
}
export interface GhTreeEntry {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}
export interface GhPull {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: 'open' | 'closed';
  merged?: boolean;
  merged_at?: string | null;
  draft?: boolean;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  user?: { login: string };
  mergeable?: boolean | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
}
export interface GhPullFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}
export interface GhIssue {
  id: number;
  number: number;
  title: string;
  body?: string | null;
  state: string;
  html_url: string;
  labels: { name: string }[];
}
export interface GhCheckRun {
  id: number;
  name: string;
  status: 'queued' | 'in_progress' | 'completed';
  conclusion: string | null;
  html_url: string;
}
export interface GhWorkflow {
  id: number;
  name: string;
  path: string;
  state: string;
}
export interface GhWorkflowRun {
  id: number;
  name?: string | null;
  display_title?: string;
  status: 'queued' | 'in_progress' | 'completed' | 'waiting' | 'requested' | 'pending';
  conclusion: string | null;
  html_url: string;
  head_branch: string | null;
  head_sha: string;
  event: string;
  run_attempt?: number;
  created_at: string;
  updated_at: string;
  workflow_id: number;
}
export interface GhJob {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  started_at?: string | null;
  completed_at?: string | null;
  html_url: string;
  steps?: { name: string; status: string; conclusion: string | null; number: number }[];
}

export interface FileChange {
  path: string;
  /** New content (utf-8). null deletes the file. */
  content: string | null;
}

export class GitHubClient {
  readonly http: HttpClient;

  constructor(options: GitHubClientOptions) {
    this.http = new HttpClient({
      baseUrl: options.apiUrl ?? 'https://api.github.com',
      provider: 'github',
      fetchImpl: options.fetchImpl,
      defaultHeaders: {
        Authorization: `Bearer ${options.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      isRateLimited: (status, headers) => status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after')),
    });
  }

  private repoPath(owner: string, repo: string): string {
    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  }

  // ── Identity & repositories ──
  getAuthenticatedUser() {
    return this.http.get<GhUser>('/user');
  }
  async getTokenScopes(): Promise<string[]> {
    const res = await this.http.request<GhUser>('/user');
    return (res.headers.get('x-oauth-scopes') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  listRepositories(page = 1, perPage = 50) {
    return this.http.get<GhRepo[]>('/user/repos', {
      query: { per_page: perPage, page, sort: 'pushed', affiliation: 'owner,collaborator,organization_member' },
    });
  }
  getRepository(owner: string, repo: string) {
    return this.http.get<GhRepo>(this.repoPath(owner, repo));
  }

  // ── Branches & refs ──
  async getRef(owner: string, repo: string, ref: string): Promise<GhRef | null> {
    const res = await this.http.request<GhRef>(`${this.repoPath(owner, repo)}/git/ref/${ref}`, { allowStatus: [404] });
    return res.status === 404 ? null : res.data;
  }
  async getBranchSha(owner: string, repo: string, branch: string): Promise<string | null> {
    const ref = await this.getRef(owner, repo, `heads/${branch}`);
    return ref?.object.sha ?? null;
  }
  listBranches(owner: string, repo: string) {
    return this.http.get<{ name: string; commit: { sha: string }; protected: boolean }[]>(`${this.repoPath(owner, repo)}/branches`, {
      query: { per_page: 100 },
    });
  }
  /** Idempotent: returns the existing branch when it already exists. */
  async createBranch(owner: string, repo: string, branch: string, fromSha: string): Promise<{ sha: string; created: boolean }> {
    const existing = await this.getBranchSha(owner, repo, branch);
    if (existing) return { sha: existing, created: false };
    try {
      const ref = await this.http.post<GhRef>(`${this.repoPath(owner, repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha: fromSha });
      return { sha: ref.object.sha, created: true };
    } catch (err) {
      // Lost a race with a concurrent attempt: treat "already exists" as success.
      if (ToolError.is(err) && err.kind === 'validation') {
        const sha = await this.getBranchSha(owner, repo, branch);
        if (sha) return { sha, created: false };
      }
      throw err;
    }
  }
  async deleteBranch(owner: string, repo: string, branch: string): Promise<boolean> {
    const res = await this.http.request(`${this.repoPath(owner, repo)}/git/refs/heads/${branch}`, {
      method: 'DELETE',
      allowStatus: [404, 422],
      responseType: 'none',
    });
    return res.status === 204;
  }

  // ── Contents & trees ──
  async getFileContent(owner: string, repo: string, path: string, ref?: string): Promise<{ content: string; sha: string } | null> {
    const res = await this.http.request<{ content?: string; encoding?: string; sha: string; type: string }>(
      `${this.repoPath(owner, repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`,
      { query: { ref }, allowStatus: [404] },
    );
    if (res.status === 404 || !res.data) return null;
    if (res.data.type !== 'file' || res.data.content === undefined) return null;
    const content = res.data.encoding === 'base64' ? Buffer.from(res.data.content, 'base64').toString('utf8') : res.data.content;
    return { content, sha: res.data.sha };
  }
  async getTree(owner: string, repo: string, sha: string, recursive = true): Promise<{ tree: GhTreeEntry[]; truncated: boolean }> {
    return this.http.get(`${this.repoPath(owner, repo)}/git/trees/${sha}`, { query: { recursive: recursive ? '1' : undefined } });
  }
  async getBlob(owner: string, repo: string, sha: string): Promise<string> {
    const blob = await this.http.get<{ content: string; encoding: string }>(`${this.repoPath(owner, repo)}/git/blobs/${sha}`);
    return blob.encoding === 'base64' ? Buffer.from(blob.content, 'base64').toString('utf8') : blob.content;
  }
  /** Download a tarball of a ref (used by the sandbox to materialise a checkout). */
  async downloadTarball(owner: string, repo: string, ref: string, signal?: AbortSignal): Promise<ArrayBuffer> {
    const res = await this.http.request<ArrayBuffer>(`${this.repoPath(owner, repo)}/tarball/${encodeURIComponent(ref)}`, {
      responseType: 'arrayBuffer',
      timeoutMs: 120_000,
      signal,
    });
    return res.data;
  }

  /**
   * Create a single commit with many file changes on a branch using the Git
   * Data API (no local clone, credentials never written to disk).
   */
  async commitFiles(
    owner: string,
    repo: string,
    branch: string,
    files: FileChange[],
    message: string,
    author?: { name: string; email: string },
  ): Promise<{ sha: string; url: string }> {
    const base = this.repoPath(owner, repo);
    const headSha = await this.getBranchSha(owner, repo, branch);
    if (!headSha) throw new ToolError('not_found', `Branch ${branch} does not exist in ${owner}/${repo}`, { provider: 'github' });
    const headCommit = await this.http.get<{ tree: { sha: string } }>(`${base}/git/commits/${headSha}`);
    const tree = await Promise.all(
      files.map(async (f) => {
        if (f.content === null) return { path: f.path, mode: '100644', type: 'blob', sha: null };
        const blob = await this.http.post<{ sha: string }>(
          `${base}/git/blobs`,
          {
            content: Buffer.from(f.content, 'utf8').toString('base64'),
            encoding: 'base64',
          },
          { retry: true },
        );
        return { path: f.path, mode: '100644', type: 'blob', sha: blob.sha };
      }),
    );
    const newTree = await this.http.post<{ sha: string }>(`${base}/git/trees`, { base_tree: headCommit.tree.sha, tree }, { retry: true });
    const commit = await this.http.post<{ sha: string; html_url: string }>(
      `${base}/git/commits`,
      { message, tree: newTree.sha, parents: [headSha], ...(author && { author }) },
      { retry: true },
    );
    await this.http.patch(`${base}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    return { sha: commit.sha, url: commit.html_url };
  }

  compare(owner: string, repo: string, base: string, head: string) {
    return this.http.get<{
      status: string;
      ahead_by: number;
      behind_by: number;
      files?: GhPullFile[];
      commits: { sha: string; commit: { message: string } }[];
    }>(`${this.repoPath(owner, repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
  }

  // ── Pull requests ──
  listPullRequests(
    owner: string,
    repo: string,
    params: { state?: 'open' | 'closed' | 'all'; head?: string; base?: string; perPage?: number } = {},
  ) {
    return this.http.get<GhPull[]>(`${this.repoPath(owner, repo)}/pulls`, {
      query: { state: params.state ?? 'open', head: params.head, base: params.base, per_page: params.perPage ?? 30 },
    });
  }
  getPullRequest(owner: string, repo: string, number: number) {
    return this.http.get<GhPull>(`${this.repoPath(owner, repo)}/pulls/${number}`);
  }
  async getPullRequestDiff(owner: string, repo: string, number: number): Promise<string> {
    const res = await this.http.request<string>(`${this.repoPath(owner, repo)}/pulls/${number}`, {
      headers: { Accept: 'application/vnd.github.diff' },
      responseType: 'text',
    });
    return res.data;
  }
  listPullRequestFiles(owner: string, repo: string, number: number) {
    return this.http.get<GhPullFile[]>(`${this.repoPath(owner, repo)}/pulls/${number}/files`, { query: { per_page: 100 } });
  }
  /** Idempotent: returns the open PR for the head branch if one exists. */
  async createPullRequest(
    owner: string,
    repo: string,
    params: { title: string; body: string; head: string; base: string; draft?: boolean },
  ): Promise<{ pull: GhPull; created: boolean }> {
    const existing = await this.listPullRequests(owner, repo, { state: 'open', head: `${owner}:${params.head}`, base: params.base });
    if (existing[0]) return { pull: existing[0], created: false };
    const pull = await this.http.post<GhPull>(`${this.repoPath(owner, repo)}/pulls`, params);
    return { pull, created: true };
  }
  updatePullRequest(owner: string, repo: string, number: number, patch: { title?: string; body?: string; state?: 'open' | 'closed' }) {
    return this.http.patch<GhPull>(`${this.repoPath(owner, repo)}/pulls/${number}`, patch);
  }
  mergePullRequest(
    owner: string,
    repo: string,
    number: number,
    params: { method?: 'merge' | 'squash' | 'rebase'; sha?: string; title?: string },
  ) {
    return this.http.put<{ merged: boolean; sha: string; message: string }>(`${this.repoPath(owner, repo)}/pulls/${number}/merge`, {
      merge_method: params.method ?? 'squash',
      sha: params.sha,
      commit_title: params.title,
    });
  }
  createReview(
    owner: string,
    repo: string,
    number: number,
    review: {
      body: string;
      event: 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';
      commitId?: string;
      comments?: { path: string; line: number; side?: 'LEFT' | 'RIGHT'; body: string }[];
    },
  ) {
    return this.http.post<{ id: number; html_url: string; state: string }>(`${this.repoPath(owner, repo)}/pulls/${number}/reviews`, {
      body: review.body,
      event: review.event,
      commit_id: review.commitId,
      comments: review.comments?.map((c) => ({ path: c.path, line: c.line, side: c.side ?? 'RIGHT', body: c.body })),
    });
  }
  listReviews(owner: string, repo: string, number: number) {
    return this.http.get<{ id: number; body: string; state: string; user: { login: string } }[]>(
      `${this.repoPath(owner, repo)}/pulls/${number}/reviews`,
    );
  }

  // ── Issues & comments ──
  createIssue(owner: string, repo: string, params: { title: string; body?: string; labels?: string[] }) {
    return this.http.post<GhIssue>(`${this.repoPath(owner, repo)}/issues`, params);
  }
  getIssue(owner: string, repo: string, number: number) {
    return this.http.get<GhIssue>(`${this.repoPath(owner, repo)}/issues/${number}`);
  }
  createIssueComment(owner: string, repo: string, number: number, body: string) {
    return this.http.post<{ id: number; html_url: string }>(`${this.repoPath(owner, repo)}/issues/${number}/comments`, { body });
  }
  listIssueComments(owner: string, repo: string, number: number) {
    return this.http.get<{ id: number; body: string; html_url: string }[]>(`${this.repoPath(owner, repo)}/issues/${number}/comments`, {
      query: { per_page: 100 },
    });
  }

  // ── Search ──
  searchCode(query: string, perPage = 20) {
    return this.http.get<{
      total_count: number;
      items: { name: string; path: string; html_url: string; repository: { full_name: string } }[];
    }>('/search/code', { query: { q: query, per_page: perPage } });
  }
  searchIssues(query: string, perPage = 20) {
    return this.http.get<{ total_count: number; items: (GhIssue & { pull_request?: unknown })[] }>('/search/issues', {
      query: { q: query, per_page: perPage },
    });
  }

  // ── Checks ──
  listCheckRuns(owner: string, repo: string, ref: string) {
    return this.http.get<{ total_count: number; check_runs: GhCheckRun[] }>(`${this.repoPath(owner, repo)}/commits/${ref}/check-runs`, {
      query: { per_page: 100 },
    });
  }

  // ── Webhooks ──
  createRepositoryWebhook(owner: string, repo: string, params: { url: string; secret: string; events: string[] }) {
    return this.http.post<{ id: number }>(`${this.repoPath(owner, repo)}/hooks`, {
      name: 'web',
      active: true,
      events: params.events,
      config: { url: params.url, content_type: 'json', secret: params.secret, insecure_ssl: '0' },
    });
  }
  deleteRepositoryWebhook(owner: string, repo: string, hookId: number) {
    return this.http.delete(`${this.repoPath(owner, repo)}/hooks/${hookId}`, { allowStatus: [404], responseType: 'none' });
  }

  // ── Actions ──
  listWorkflows(owner: string, repo: string) {
    return this.http.get<{ workflows: GhWorkflow[] }>(`${this.repoPath(owner, repo)}/actions/workflows`, { query: { per_page: 100 } });
  }
  async dispatchWorkflow(
    owner: string,
    repo: string,
    workflow: string | number,
    ref: string,
    inputs: Record<string, string> = {},
  ): Promise<void> {
    await this.http.request(`${this.repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(String(workflow))}/dispatches`, {
      method: 'POST',
      body: { ref, inputs },
      responseType: 'none',
    });
  }
  listWorkflowRuns(
    owner: string,
    repo: string,
    params: { workflow?: string | number; branch?: string; event?: string; createdAfter?: string; headSha?: string; perPage?: number } = {},
  ) {
    const path = params.workflow
      ? `${this.repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(String(params.workflow))}/runs`
      : `${this.repoPath(owner, repo)}/actions/runs`;
    return this.http.get<{ total_count: number; workflow_runs: GhWorkflowRun[] }>(path, {
      query: {
        branch: params.branch,
        event: params.event,
        head_sha: params.headSha,
        created: params.createdAfter ? `>=${params.createdAfter}` : undefined,
        per_page: params.perPage ?? 20,
      },
    });
  }
  getWorkflowRun(owner: string, repo: string, runId: number) {
    return this.http.get<GhWorkflowRun>(`${this.repoPath(owner, repo)}/actions/runs/${runId}`);
  }
  listJobsForRun(owner: string, repo: string, runId: number) {
    return this.http.get<{ total_count: number; jobs: GhJob[] }>(`${this.repoPath(owner, repo)}/actions/runs/${runId}/jobs`, {
      query: { per_page: 100 },
    });
  }
  async getJobLogs(owner: string, repo: string, jobId: number): Promise<string> {
    // Responds with a redirect to a short-lived log URL; fetch follows it.
    const res = await this.http.request<string>(`${this.repoPath(owner, repo)}/actions/jobs/${jobId}/logs`, {
      responseType: 'text',
      headers: { Accept: 'application/vnd.github+json' },
    });
    return res.data;
  }
  async rerunWorkflow(owner: string, repo: string, runId: number, failedOnly = false): Promise<void> {
    await this.http.request(`${this.repoPath(owner, repo)}/actions/runs/${runId}/${failedOnly ? 'rerun-failed-jobs' : 'rerun'}`, {
      method: 'POST',
      responseType: 'none',
    });
  }
  async cancelWorkflowRun(owner: string, repo: string, runId: number): Promise<void> {
    await this.http.request(`${this.repoPath(owner, repo)}/actions/runs/${runId}/cancel`, {
      method: 'POST',
      responseType: 'none',
      allowStatus: [409],
    });
  }
  listEnvironments(owner: string, repo: string) {
    return this.http.get<{ environments: { id: number; name: string; html_url: string }[] }>(`${this.repoPath(owner, repo)}/environments`, {
      allowStatus: [404],
    });
  }
}

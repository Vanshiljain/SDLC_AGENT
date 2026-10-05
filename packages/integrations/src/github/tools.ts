import { z } from 'zod';
import { ToolError } from '@forgeline/shared';
import { defineTool, idempotencyMarker, type AnySdlcTool } from '../core/tool';
import { demoNumber, resolveRepo, truncate } from '../core/helpers';

const repoField = z
  .string()
  .regex(/^[\w.-]+\/[\w.-]+$/)
  .optional()
  .describe('owner/name; defaults to the project repository');
const branchName = z
  .string()
  .min(1)
  .max(200)
  .regex(/^(?!\/|.*\/\/|.*\.\.|.*@\{|.*\.lock$)[\w./-]+$/, 'Invalid git branch name');

export const githubGetRepository = defineTool({
  name: 'github.getRepository',
  title: 'Get repository',
  description: 'Read repository metadata (default branch, language, visibility).',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({ repository: repoField }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const r = await gh.getRepository(repo.owner, repo.name);
    return {
      output: {
        fullName: r.full_name,
        defaultBranch: r.default_branch,
        language: r.language ?? null,
        private: r.private,
        url: r.html_url,
        description: r.description ?? null,
      },
      summary: `${r.full_name} (default branch ${r.default_branch})`,
    };
  },
});

export const githubAnalyzeRepository = defineTool({
  name: 'github.analyzeRepository',
  title: 'Analyze repository',
  description: 'Inspect the repository tree: languages, frameworks, key files, test setup and size.',
  category: 'github',
  provider: 'GITHUB',
  agent: 'architect',
  inputSchema: z.object({ repository: repoField, ref: z.string().optional() }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const ref = input.ref ?? repo.defaultBranch;
    const sha = await gh.getBranchSha(repo.owner, repo.name, ref);
    if (!sha) throw new ToolError('not_found', `Ref ${ref} not found in ${repo.owner}/${repo.name}`);
    const { tree, truncated } = await gh.getTree(repo.owner, repo.name, sha);
    const files = tree.filter((t) => t.type === 'blob').map((t) => t.path);
    const ext = new Map<string, number>();
    for (const f of files) {
      const e = f.includes('.') ? f.slice(f.lastIndexOf('.') + 1).toLowerCase() : '(none)';
      ext.set(e, (ext.get(e) ?? 0) + 1);
    }
    const has = (re: RegExp) => files.some((f) => re.test(f));
    const manifests = files.filter((f) =>
      /(^|\/)(package\.json|pyproject\.toml|go\.mod|pom\.xml|build\.gradle|Cargo\.toml|requirements\.txt|Gemfile)$/.test(f),
    );
    let packageJson: Record<string, unknown> | null = null;
    if (files.includes('package.json')) {
      const pj = await gh.getFileContent(repo.owner, repo.name, 'package.json', sha);
      try {
        packageJson = pj ? (JSON.parse(pj.content) as Record<string, unknown>) : null;
      } catch {
        packageJson = null;
      }
    }
    const deps = packageJson ? Object.keys({ ...(packageJson.dependencies as object), ...(packageJson.devDependencies as object) }) : [];
    const frameworks = [
      'react',
      'next',
      'vue',
      '@angular/core',
      '@nestjs/core',
      'express',
      'fastify',
      'prisma',
      'typeorm',
      'jest',
      'vitest',
      'mocha',
      'playwright',
      'cypress',
    ].filter((d) => deps.includes(d));
    const output = {
      ref,
      sha,
      fileCount: files.length,
      truncated,
      languages: [...ext.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([e, n]) => ({ extension: e, files: n })),
      manifests,
      frameworks,
      scripts: (packageJson?.scripts as Record<string, string> | undefined) ?? {},
      hasTests: has(/(\.test\.|\.spec\.|__tests__|^tests?\/)/),
      hasCi: has(/^\.github\/workflows\//),
      hasDocker: has(/(^|\/)Dockerfile$/),
      topLevel: [...new Set(files.map((f) => f.split('/')[0]!))].slice(0, 50),
      sampleFiles: files.filter((f) => !/node_modules|dist\//.test(f)).slice(0, 400),
    };
    return {
      output,
      summary: `Analyzed ${repo.owner}/${repo.name}@${ref}: ${files.length} files${frameworks.length ? `, ${frameworks.join(', ')}` : ''}`,
    };
  },
  async simulate(input, ctx) {
    const repo = ctx.project?.repository;
    return {
      simulated: true,
      output: {
        ref: repo?.defaultBranch ?? 'main',
        sha: 'demo',
        fileCount: 214,
        truncated: false,
        languages: [{ extension: 'ts', files: 168 }],
        manifests: ['package.json'],
        frameworks: ['@nestjs/core', 'prisma', 'jest'],
        scripts: { test: 'jest' },
        hasTests: true,
        hasCi: true,
        hasDocker: true,
        topLevel: ['src', 'test', 'prisma'],
        sampleFiles: ['src/auth/auth.service.ts', 'src/auth/auth.controller.ts', 'src/users/users.service.ts'],
      },
      summary: `[Simulated] Analyzed ${repo?.fullName ?? input.repository ?? 'demo repository'}: 214 files, NestJS + Prisma`,
    };
  },
});

export const githubGetFile = defineTool({
  name: 'github.getFile',
  title: 'Read file',
  description: 'Read a file from the repository at a ref.',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({ repository: repoField, path: z.string().min(1).max(500), ref: z.string().optional() }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const file = await gh.getFileContent(repo.owner, repo.name, input.path, input.ref ?? repo.defaultBranch);
    if (!file) throw new ToolError('not_found', `${input.path} not found`);
    return { output: { path: input.path, content: truncate(file.content, 100_000), sha: file.sha }, summary: `Read ${input.path}` };
  },
});

export const githubSearchCode = defineTool({
  name: 'github.searchCode',
  title: 'Search code',
  description: 'Search code in the repository using GitHub code search.',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({ repository: repoField, query: z.string().min(1).max(256) }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const res = await gh.searchCode(`${input.query} repo:${repo.owner}/${repo.name}`);
    const items = res.items.map((i) => ({ path: i.path, url: i.html_url }));
    return { output: { total: res.total_count, items }, summary: `${res.total_count} matches for "${input.query}"` };
  },
});

export const githubCreateBranch = defineTool({
  name: 'github.createBranch',
  title: 'Create branch',
  description: 'Create a branch from the default branch (or a given ref). Idempotent.',
  category: 'github',
  provider: 'GITHUB',
  agent: 'code',
  inputSchema: z.object({ repository: repoField, branch: branchName, from: z.string().optional() }),
  permission: 'code:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const from = input.from ?? repo.defaultBranch;
    const baseSha = (await gh.getBranchSha(repo.owner, repo.name, from)) ?? (/^[0-9a-f]{40}$/.test(from) ? from : null);
    if (!baseSha) throw new ToolError('not_found', `Base ref ${from} not found`);
    const { sha, created } = await gh.createBranch(repo.owner, repo.name, input.branch, baseSha);
    const url = `${repo.repository?.url ?? `https://github.com/${repo.owner}/${repo.name}`}/tree/${input.branch}`;
    return {
      output: { branch: input.branch, sha, baseBranch: from, baseSha, created, repository: `${repo.owner}/${repo.name}`, url },
      summary: created ? `Created branch ${input.branch} from ${from}` : `Branch ${input.branch} already exists`,
      externalResources: [
        {
          provider: 'GITHUB',
          type: 'GITHUB_BRANCH',
          externalId: `${repo.owner}/${repo.name}#${input.branch}`,
          key: input.branch,
          title: input.branch,
          url,
        },
      ],
    };
  },
  async compensate(input, output, ctx) {
    if (!output.created) return { summary: 'Branch pre-existed; left untouched' };
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    await gh.deleteBranch(repo.owner, repo.name, input.branch);
    return { summary: `Deleted branch ${input.branch}` };
  },
  async simulate(input, ctx) {
    const base = input.from ?? ctx.project?.repository?.defaultBranch ?? 'main';
    return {
      simulated: true,
      output: {
        branch: input.branch,
        sha: 'demo0000',
        baseBranch: base,
        baseSha: 'demo0000',
        created: true,
        repository: ctx.project?.repository?.fullName ?? 'demo/repo',
        url: null,
      },
      summary: `[Simulated] Created branch ${input.branch} from ${base}`,
      externalResources: [
        {
          provider: 'GITHUB',
          type: 'GITHUB_BRANCH',
          externalId: `demo#${input.branch}#${ctx.idempotencyKey}`,
          key: input.branch,
          title: input.branch,
        },
      ],
    };
  },
});

const fileChange = z.object({
  path: z
    .string()
    .min(1)
    .max(500)
    .refine((p) => !p.startsWith('/') && !p.includes('..'), 'Invalid path'),
  content: z.string().max(1_000_000).nullable(),
});

export const githubCommitFiles = defineTool({
  name: 'github.commitFiles',
  title: 'Commit changes',
  description: 'Create one commit containing the given file changes on a branch (Git Data API).',
  category: 'github',
  provider: 'GITHUB',
  agent: 'code',
  inputSchema: z.object({
    repository: repoField,
    branch: branchName,
    message: z.string().min(1).max(5000),
    files: z.array(fileChange).min(1).max(300),
  }),
  permission: 'code:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const defaultBranch = ctx.project?.repository?.defaultBranch ?? repo.defaultBranch;
    if (input.branch === defaultBranch) {
      throw new ToolError(
        'permission',
        `Refusing to commit directly to the default branch (${defaultBranch}); use a feature branch and a pull request.`,
        { retryable: false },
      );
    }
    const gh = await ctx.clients.github();
    const marker = idempotencyMarker(ctx);
    // Idempotency: if the branch head already carries our marker, the commit happened.
    const headSha = await gh.getBranchSha(repo.owner, repo.name, input.branch);
    if (headSha) {
      const head = await gh.http.get<{ sha: string; message: string; html_url: string }>(
        `/repos/${repo.owner}/${repo.name}/git/commits/${headSha}`,
      );
      if (head.message.includes(marker)) {
        return {
          output: { sha: head.sha, url: head.html_url, branch: input.branch, files: input.files.length, reused: true },
          summary: `Commit ${head.sha.slice(0, 7)} already on ${input.branch}`,
        };
      }
    }
    const message = `${input.message.trim()}\n\nForgeline-Ref: ${marker}`;
    const commit = await gh.commitFiles(repo.owner, repo.name, input.branch, input.files, message);
    return {
      output: { sha: commit.sha, url: commit.url, branch: input.branch, files: input.files.length, reused: false },
      summary: `Committed ${input.files.length} file(s) to ${input.branch} (${commit.sha.slice(0, 7)})`,
      externalResources: [
        {
          provider: 'GITHUB',
          type: 'GITHUB_COMMIT',
          externalId: commit.sha,
          key: commit.sha.slice(0, 7),
          title: input.message.split('\n')[0],
          url: commit.url,
        },
      ],
    };
  },
  async simulate(input, ctx) {
    const sha = `demo${demoNumber(ctx.idempotencyKey, 100000, 999999)}`;
    return {
      simulated: true,
      output: { sha, url: null, branch: input.branch, files: input.files.length, reused: false },
      summary: `[Simulated] Committed ${input.files.length} file(s) to ${input.branch}`,
    };
  },
});

export const githubCreatePullRequest = defineTool({
  name: 'github.createPullRequest',
  title: 'Create pull request',
  description: 'Open a pull request (idempotent: reuses an open PR for the same head branch).',
  category: 'github',
  provider: 'GITHUB',
  agent: 'code',
  inputSchema: z.object({
    repository: repoField,
    head: branchName,
    base: z.string().optional(),
    title: z.string().min(1).max(256),
    body: z.string().max(65_000).default(''),
    draft: z.boolean().default(false),
  }),
  permission: 'code:write',
  risk: 'write',
  sideEffects: true,
  approvalAction: 'pr.create',
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const { pull, created } = await gh.createPullRequest(repo.owner, repo.name, {
      title: input.title,
      body: input.body,
      head: input.head,
      base: input.base ?? repo.defaultBranch,
      draft: input.draft,
    });
    return {
      output: {
        number: pull.number,
        url: pull.html_url,
        headSha: pull.head.sha,
        head: pull.head.ref,
        base: pull.base.ref,
        created,
        repository: `${repo.owner}/${repo.name}`,
      },
      summary: created ? `Opened PR #${pull.number}: ${pull.title}` : `PR #${pull.number} already open for ${input.head}`,
      externalResources: [
        {
          provider: 'GITHUB',
          type: 'GITHUB_PULL_REQUEST',
          externalId: `${repo.owner}/${repo.name}#${pull.number}`,
          key: `#${pull.number}`,
          title: pull.title,
          url: pull.html_url,
          status: 'open',
        },
      ],
    };
  },
  async compensate(input, output, ctx) {
    if (!output.created) return { summary: 'PR pre-existed; left open' };
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    await gh.updatePullRequest(repo.owner, repo.name, output.number, { state: 'closed' });
    await gh.createIssueComment(repo.owner, repo.name, output.number, 'Closed by Forgeline: the run that opened this PR was rolled back.');
    return { summary: `Closed PR #${output.number}` };
  },
  async simulate(input, ctx) {
    const n = demoNumber(ctx.idempotencyKey, 100, 899);
    return {
      simulated: true,
      output: {
        number: n,
        url: null,
        headSha: 'demo',
        head: input.head,
        base: input.base ?? 'main',
        created: true,
        repository: ctx.project?.repository?.fullName ?? 'demo/repo',
      },
      summary: `[Simulated] Opened PR #${n}: ${input.title}`,
      externalResources: [
        {
          provider: 'GITHUB',
          type: 'GITHUB_PULL_REQUEST',
          externalId: `demo#pr-${n}-${ctx.idempotencyKey}`,
          key: `#${n}`,
          title: input.title,
          status: 'open',
        },
      ],
    };
  },
});

export const githubGetPullRequest = defineTool({
  name: 'github.getPullRequest',
  title: 'Get pull request',
  description: 'Read a pull request with changed files and the unified diff.',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({ repository: repoField, number: z.coerce.number().int().positive(), includeDiff: z.boolean().default(true) }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const [pull, files] = await Promise.all([
      gh.getPullRequest(repo.owner, repo.name, input.number),
      gh.listPullRequestFiles(repo.owner, repo.name, input.number),
    ]);
    const diff = input.includeDiff ? await gh.getPullRequestDiff(repo.owner, repo.name, input.number) : null;
    return {
      output: {
        number: pull.number,
        title: pull.title,
        body: pull.body ?? '',
        state: pull.state,
        merged: Boolean(pull.merged),
        url: pull.html_url,
        head: pull.head.ref,
        headSha: pull.head.sha,
        base: pull.base.ref,
        files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions })),
        diff: diff ? truncate(diff, 200_000) : null,
      },
      summary: `PR #${pull.number} "${pull.title}" — ${files.length} files changed`,
    };
  },
});

export const githubMergePullRequest = defineTool({
  name: 'github.mergePullRequest',
  title: 'Merge pull request',
  description: 'Merge a pull request. Always gated by approval.',
  category: 'github',
  provider: 'GITHUB',
  agent: 'release',
  inputSchema: z.object({
    repository: repoField,
    number: z.coerce.number().int().positive(),
    method: z.enum(['merge', 'squash', 'rebase']).default('squash'),
    expectedHeadSha: z.string().optional(),
  }),
  permission: 'code:merge',
  risk: 'destructive',
  sideEffects: true,
  approvalAction: 'pr.merge',
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const pull = await gh.getPullRequest(repo.owner, repo.name, input.number);
    if (pull.merged) {
      return { output: { merged: true, sha: pull.head.sha, alreadyMerged: true }, summary: `PR #${input.number} was already merged` };
    }
    const res = await gh.mergePullRequest(repo.owner, repo.name, input.number, { method: input.method, sha: input.expectedHeadSha });
    return { output: { merged: res.merged, sha: res.sha, alreadyMerged: false }, summary: `Merged PR #${input.number} (${input.method})` };
  },
  async simulate(input) {
    return {
      simulated: true,
      output: { merged: true, sha: 'demo', alreadyMerged: false },
      summary: `[Simulated] Merged PR #${input.number}`,
    };
  },
});

export const githubCommentOnPullRequest = defineTool({
  name: 'github.commentOnPullRequest',
  title: 'Comment on PR / issue',
  description: 'Add a comment to a pull request or issue.',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({ repository: repoField, number: z.coerce.number().int().positive(), body: z.string().min(1).max(65_000) }),
  permission: 'code:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const marker = `<!-- ${idempotencyMarker(ctx)} -->`;
    const existing = await gh.listIssueComments(repo.owner, repo.name, input.number);
    const dup = existing.find((c) => c.body.includes(marker));
    if (dup) return { output: { id: dup.id, url: dup.html_url }, summary: `Comment already posted on #${input.number}` };
    const c = await gh.createIssueComment(repo.owner, repo.name, input.number, `${input.body}\n\n${marker}`);
    return { output: { id: c.id, url: c.html_url }, summary: `Commented on #${input.number}` };
  },
  async simulate(input) {
    return { simulated: true, output: { id: 0, url: null }, summary: `[Simulated] Commented on #${input.number}` };
  },
});

export const githubCreateIssue = defineTool({
  name: 'github.createIssue',
  title: 'Create GitHub issue',
  description: 'Create a GitHub issue (idempotent via marker label search).',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({
    repository: repoField,
    title: z.string().min(1).max(256),
    body: z.string().max(65_000).default(''),
    labels: z.array(z.string()).default([]),
  }),
  permission: 'ticket:write',
  risk: 'write',
  sideEffects: true,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const marker = idempotencyMarker(ctx);
    const found = await gh.searchIssues(`repo:${repo.owner}/${repo.name} is:issue "${marker}" in:body`);
    const issue =
      found.items[0] ??
      (await gh.createIssue(repo.owner, repo.name, {
        title: input.title,
        body: `${input.body}\n\n<!-- ${marker} -->`,
        labels: input.labels,
      }));
    return {
      output: { number: issue.number, url: issue.html_url },
      summary: `Issue #${issue.number}: ${issue.title}`,
      externalResources: [
        {
          provider: 'GITHUB',
          type: 'GITHUB_ISSUE',
          externalId: `${repo.owner}/${repo.name}#issue-${issue.number}`,
          key: `#${issue.number}`,
          title: issue.title,
          url: issue.html_url,
        },
      ],
    };
  },
});

export const githubListPullRequests = defineTool({
  name: 'github.listPullRequests',
  title: 'List pull requests',
  description: 'List open pull requests for the project repository.',
  category: 'github',
  provider: 'GITHUB',
  inputSchema: z.object({ repository: repoField, state: z.enum(['open', 'closed', 'all']).default('open') }),
  permission: 'project:read',
  risk: 'read',
  sideEffects: false,
  async execute(input, ctx) {
    const repo = resolveRepo(input.repository, ctx);
    const gh = await ctx.clients.github();
    const pulls = await gh.listPullRequests(repo.owner, repo.name, { state: input.state });
    return {
      output: {
        items: pulls.map((p) => ({
          number: p.number,
          title: p.title,
          url: p.html_url,
          head: p.head.ref,
          author: p.user?.login ?? null,
          draft: Boolean(p.draft),
        })),
      },
      summary: `${pulls.length} ${input.state} pull request(s)`,
    };
  },
});

export const githubTools: AnySdlcTool[] = [
  githubGetRepository,
  githubAnalyzeRepository,
  githubGetFile,
  githubSearchCode,
  githubCreateBranch,
  githubCommitFiles,
  githubCreatePullRequest,
  githubGetPullRequest,
  githubMergePullRequest,
  githubCommentOnPullRequest,
  githubCreateIssue,
  githubListPullRequests,
];

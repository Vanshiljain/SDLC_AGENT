import { ToolError } from '@forgeline/shared';
import type { ProjectRepositoryContext, ToolExecutionContext } from './tool';

export interface RepoRef {
  owner: string;
  name: string;
  defaultBranch: string;
  repository?: ProjectRepositoryContext | null;
}

/** Resolve "owner/name" from input or the project's primary repository. */
export function resolveRepo(repository: string | undefined, ctx: ToolExecutionContext): RepoRef {
  if (repository) {
    const [owner, name] = repository.split('/');
    if (!owner || !name) throw new ToolError('validation', `Repository must be "owner/name", got "${repository}"`);
    const projectRepo = ctx.project?.repository;
    const same = projectRepo && projectRepo.fullName.toLowerCase() === `${owner}/${name}`.toLowerCase();
    return { owner, name, defaultBranch: same ? projectRepo.defaultBranch : 'main', repository: same ? projectRepo : null };
  }
  const repo = ctx.project?.repository;
  if (!repo) {
    throw new ToolError('not_configured', 'No repository is linked to this project. Link a GitHub repository in project settings.', {
      retryable: false,
    });
  }
  return { owner: repo.owner, name: repo.name, defaultBranch: repo.defaultBranch, repository: repo };
}

/** Deterministic pseudo-identifiers for demo-mode simulations. */
export function demoNumber(seed: string, min = 100, max = 999): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
  return min + (Math.abs(h) % (max - min + 1));
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 20)}\n… [truncated ${text.length - max + 20} chars]` : text;
}

/** Extract the tail of CI logs, focusing on error lines. */
export function summarizeLogs(log: string, maxChars = 6000): string {
  const lines = log.split(/\r?\n/).map((l) => l.replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/, ''));
  const errorIdx = lines.findIndex((l) => /(##\[error\]|error|failed|FAIL|✕|×)/.test(l));
  const start = errorIdx >= 0 ? Math.max(0, errorIdx - 30) : Math.max(0, lines.length - 200);
  return truncate(lines.slice(start).join('\n'), maxChars);
}

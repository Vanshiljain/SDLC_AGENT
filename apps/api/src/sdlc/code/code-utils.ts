import { createTwoFilesPatch } from 'diff';
import { ToolError } from '@forgeline/shared';

export interface StoredFile {
  path: string;
  action: 'create' | 'modify' | 'delete';
  content: string | null;
  explanation: string;
  /** Content on the base branch (null when the file is new). */
  original: string | null;
}

const FORBIDDEN_PATHS = [/^\.git\//, /(^|\/)\.env(\.|$)/, /\.(pem|key|p12|pfx)$/i, /(^|\/)id_(rsa|ed25519)/, /(^|\/)node_modules\//];
const MAX_FILE_BYTES = 400_000;
const MAX_TOTAL_BYTES = 3_000_000;

/** Validate an LLM-produced change set before it touches a workspace or a branch. */
export function sanitizeChangeSet(
  files: { path: string; action: string; content: string | null; explanation: string }[],
): { path: string; action: 'create' | 'modify' | 'delete'; content: string | null; explanation: string }[] {
  const seen = new Set<string>();
  let total = 0;
  const out: { path: string; action: 'create' | 'modify' | 'delete'; content: string | null; explanation: string }[] = [];
  for (const f of files) {
    const path = f.path
      .trim()
      .replace(/^\.\/+/, '')
      .replace(/^\/+/, '');
    if (!path || path.includes('..') || path.includes('\\') || path.includes('\0'))
      throw new ToolError('validation', `Invalid path in change set: ${f.path}`, { retryable: false });
    if (FORBIDDEN_PATHS.some((re) => re.test(path)))
      throw new ToolError('validation', `Refusing to modify sensitive path: ${path}`, { retryable: false });
    if (seen.has(path)) continue;
    seen.add(path);
    const action = (['create', 'modify', 'delete'].includes(f.action) ? f.action : 'modify') as 'create' | 'modify' | 'delete';
    if (action !== 'delete' && (f.content === null || f.content === undefined))
      throw new ToolError('malformed_response', `Missing content for ${path}`, { retryable: true });
    const content = action === 'delete' ? null : f.content!;
    if (content && /\.\.\.\s*(rest|remaining|existing)\s+(of\s+)?(the\s+)?(code|file)|\/\/\s*\.\.\.\s*existing code/i.test(content)) {
      throw new ToolError('malformed_response', `Generated ${path} contains placeholder text instead of complete content`, {
        retryable: true,
      });
    }
    const size = content ? Buffer.byteLength(content) : 0;
    if (size > MAX_FILE_BYTES)
      throw new ToolError('validation', `${path} exceeds the ${MAX_FILE_BYTES / 1000}KB per-file limit`, { retryable: false });
    total += size;
    out.push({ path, action, content, explanation: f.explanation });
  }
  if (total > MAX_TOTAL_BYTES) throw new ToolError('validation', 'Change set exceeds the 3MB total size limit', { retryable: false });
  if (!out.length) throw new ToolError('malformed_response', 'The model returned an empty change set', { retryable: true });
  return out;
}

export function buildDiff(files: StoredFile[]): string {
  return files
    .map((f) =>
      createTwoFilesPatch(
        f.original === null ? '/dev/null' : `a/${f.path}`,
        f.content === null ? '/dev/null' : `b/${f.path}`,
        f.original ?? '',
        f.content ?? '',
        undefined,
        undefined,
        { context: 3 },
      ),
    )
    .join('\n');
}

export function diffStats(files: StoredFile[]): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of buildDiff(files).split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) additions++;
    if (line.startsWith('-') && !line.startsWith('---')) deletions++;
  }
  return { additions, deletions };
}

/** Map of file → set of new-file line numbers present in a unified diff (valid PR comment targets). */
export function commentableLines(diff: string): Map<string, Set<number>> {
  const result = new Map<string, Set<number>>();
  let file: string | null = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
      if (file && !result.has(file)) result.set(file, new Set());
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('+')) {
      result.get(file)!.add(line);
      line++;
    } else if (raw.startsWith(' ')) {
      result.get(file)!.add(line);
      line++;
    }
  }
  return result;
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  parsed: boolean;
}

/** Parse common test-runner summaries (Jest, Vitest, Mocha, pytest, Go). */
export function parseTestSummary(output: string): TestSummary {
  const num = (re: RegExp) => {
    const m = re.exec(output);
    return m ? Number(m[1]) : 0;
  };
  // Jest: "Tests:       2 failed, 1 skipped, 10 passed, 13 total"
  const jest = /Tests:\s+(.+?)\s+total/.exec(output);
  if (jest) {
    const part = jest[0];
    return {
      failed: num(/(\d+) failed/),
      passed: Number(/(\d+) passed/.exec(part)?.[1] ?? 0),
      skipped: Number(/(\d+) (?:skipped|todo|pending)/.exec(part)?.[1] ?? 0),
      total: Number(/(\d+) total/.exec(part)?.[1] ?? 0),
      parsed: true,
    };
  }
  // Vitest: "Tests  2 failed | 10 passed (12)"
  const vitest = /Tests\s+(?:(\d+) failed\s*\|?\s*)?(?:(\d+) passed)?(?:\s*\|?\s*(\d+) skipped)?\s*\((\d+)\)/.exec(output);
  if (vitest)
    return {
      failed: Number(vitest[1] ?? 0),
      passed: Number(vitest[2] ?? 0),
      skipped: Number(vitest[3] ?? 0),
      total: Number(vitest[4] ?? 0),
      parsed: true,
    };
  // Mocha
  if (/\d+ passing/.test(output)) {
    const passed = num(/(\d+) passing/);
    const failed = num(/(\d+) failing/);
    const skipped = num(/(\d+) pending/);
    return { passed, failed, skipped, total: passed + failed + skipped, parsed: true };
  }
  // pytest: "=== 3 failed, 10 passed in 1.2s ==="
  const pytest = /=+ (.*(?:passed|failed).*) in [\d.]+s/.exec(output);
  if (pytest) {
    const passed = Number(/(\d+) passed/.exec(pytest[1]!)?.[1] ?? 0);
    const failed = Number(/(\d+) failed/.exec(pytest[1]!)?.[1] ?? 0);
    const skipped = Number(/(\d+) skipped/.exec(pytest[1]!)?.[1] ?? 0);
    return { passed, failed, skipped, total: passed + failed + skipped, parsed: true };
  }
  // go test
  const goFail = (output.match(/^--- FAIL/gm) ?? []).length;
  const goPass = (output.match(/^--- PASS/gm) ?? []).length;
  if (goFail + goPass > 0) return { passed: goPass, failed: goFail, skipped: 0, total: goPass + goFail, parsed: true };
  return { total: 0, passed: 0, failed: 0, skipped: 0, parsed: false };
}

/** Keep the most diagnostic part of command output for prompts and UI. */
export function failureExcerpt(output: string, max = 6000): string {
  const lines = output.split('\n');
  const idx = lines.findIndex((l) => /(error|fail|✕|×|expected|exception|TS\d{4})/i.test(l));
  const start = idx >= 0 ? Math.max(0, idx - 10) : Math.max(0, lines.length - 150);
  const text = lines.slice(start).join('\n');
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

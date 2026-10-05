import { RecursiveCharacterTextSplitter, type SupportedTextSplitterLanguage } from '@langchain/textsplitters';
import { createHash } from 'node:crypto';

/**
 * Parsing + chunking stage of the ingestion pipeline. Code is split along
 * language-aware boundaries; Markdown along headings; everything else
 * recursively by paragraphs/sentences. Chunks carry line ranges and the
 * nearest heading/symbol for citation.
 */

export type ContentKind = 'code' | 'markdown' | 'text';

export interface Chunk {
  index: number;
  text: string;
  startLine: number;
  endLine: number;
  heading: string | null;
  tokenEstimate: number;
}

const EXT_LANGUAGE: Record<string, SupportedTextSplitterLanguage> = {
  ts: 'js',
  tsx: 'js',
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  py: 'python',
  go: 'go',
  java: 'java',
  kt: 'java',
  rb: 'ruby',
  rs: 'rust',
  php: 'php',
  scala: 'scala',
  swift: 'swift',
  cpp: 'cpp',
  cc: 'cpp',
  c: 'cpp',
  h: 'cpp',
  proto: 'proto',
  sol: 'sol',
  html: 'html',
  md: 'markdown',
  mdx: 'markdown',
  rst: 'rst',
};

export function detectKind(
  path: string | null | undefined,
  fallback: ContentKind = 'text',
): { kind: ContentKind; language?: SupportedTextSplitterLanguage } {
  if (!path) return { kind: fallback };
  const ext = path.split('.').pop()?.toLowerCase() ?? '';
  const language = EXT_LANGUAGE[ext];
  if (language === 'markdown' || language === 'rst') return { kind: 'markdown', language };
  if (language) return { kind: 'code', language };
  if (['json', 'yaml', 'yml', 'toml', 'sql', 'prisma', 'graphql', 'sh', 'css', 'scss', 'tf'].includes(ext)) return { kind: 'code' };
  return { kind: fallback };
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contentHash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n').trim()).digest('hex');
}

/** NUL bytes are stripped: Postgres text columns reject them. */
const NUL = new RegExp(String.fromCharCode(0), 'g');

/** Normalise whitespace and strip binary-looking content. */
export function normalizeContent(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(NUL, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 2000);
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) ctrl++;
  }
  return sample.length > 0 && ctrl / sample.length > 0.1;
}

export async function chunkContent(
  content: string,
  options: { kind: ContentKind; language?: SupportedTextSplitterLanguage; chunkSize?: number; chunkOverlap?: number },
): Promise<Chunk[]> {
  const text = normalizeContent(content);
  if (!text) return [];
  const chunkSize = options.chunkSize ?? (options.kind === 'code' ? 1800 : 1500);
  const chunkOverlap = options.chunkOverlap ?? Math.round(chunkSize * 0.12);
  const splitter = options.language
    ? RecursiveCharacterTextSplitter.fromLanguage(options.language, { chunkSize, chunkOverlap })
    : new RecursiveCharacterTextSplitter({ chunkSize, chunkOverlap });
  const pieces = await splitter.splitText(text);

  // Map chunks back to line ranges and nearest preceding heading/symbol.
  const lineStarts: number[] = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (offset: number) => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  const headingRe =
    options.kind === 'markdown'
      ? /^#{1,6}\s+(.+)$/gm
      : /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:class|interface|function|def|func|type|enum|struct|impl|module)\s+([\w$]+)/gm;
  const headings: { offset: number; title: string }[] = [];
  for (const m of text.matchAll(headingRe)) headings.push({ offset: m.index ?? 0, title: m[1]!.trim() });

  const chunks: Chunk[] = [];
  let cursor = 0;
  pieces.forEach((piece, index) => {
    const found = text.indexOf(piece, Math.max(0, cursor - chunkOverlap - 10));
    const start = found >= 0 ? found : cursor;
    cursor = start + piece.length;
    const heading = [...headings].reverse().find((h) => h.offset <= start)?.title ?? null;
    chunks.push({
      index,
      text: piece,
      startLine: lineAt(start),
      endLine: lineAt(Math.max(start, start + piece.length - 1)),
      heading,
      tokenEstimate: estimateTokens(piece),
    });
  });
  return chunks;
}

/** Deterministic UUID (v5-style layout) for a chunk so re-ingestion overwrites instead of duplicating. */
export function chunkPointId(documentId: string, chunkIndex: number): string {
  const h = createHash('sha1').update(`${documentId}:${chunkIndex}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16)}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

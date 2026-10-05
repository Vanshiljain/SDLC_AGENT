/**
 * Minimal Markdown → Atlassian Document Format converter for ticket
 * descriptions and comments. Supports headings, paragraphs, bullet/ordered
 * lists, fenced code blocks, block quotes, horizontal rules, and inline
 * bold/italic/code/links.
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}

export interface AdfDocument {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

const INLINE_RE = /(\*\*([^*]+)\*\*|__([^_]+)__|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|_([^_]+)_)/g;

export function inlineToAdf(text: string): AdfNode[] {
  const nodes: AdfNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) nodes.push({ type: 'text', text: text.slice(last, idx) });
    if (m[2] ?? m[3]) nodes.push({ type: 'text', text: (m[2] ?? m[3])!, marks: [{ type: 'strong' }] });
    else if (m[4]) nodes.push({ type: 'text', text: m[4], marks: [{ type: 'code' }] });
    else if (m[5] && m[6]) nodes.push({ type: 'text', text: m[5], marks: [{ type: 'link', attrs: { href: m[6] } }] });
    else if (m[7] ?? m[8]) nodes.push({ type: 'text', text: (m[7] ?? m[8])!, marks: [{ type: 'em' }] });
    last = idx + m[0].length;
  }
  if (last < text.length) nodes.push({ type: 'text', text: text.slice(last) });
  return nodes.filter((n) => n.text !== '');
}

export function markdownToAdf(markdown: string): AdfDocument {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const content: AdfNode[] = [];
  let i = 0;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length) {
      const inline = inlineToAdf(paragraph.join(' ').trim());
      if (inline.length) content.push({ type: 'paragraph', content: inline });
      paragraph = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^```(\w+)?\s*$/.exec(line);
    if (fence) {
      flushParagraph();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      i++;
      content.push({ type: 'codeBlock', attrs: fence[1] ? { language: fence[1] } : {}, content: code.length ? [{ type: 'text', text: code.join('\n') }] : [] });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      content.push({ type: 'heading', attrs: { level: heading[1]!.length }, content: inlineToAdf(heading[2]!.trim()) });
      i++;
      continue;
    }
    if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) {
      flushParagraph();
      content.push({ type: 'rule' });
      i++;
      continue;
    }
    const listMatch = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatch) {
      flushParagraph();
      const ordered = /\d/.test(listMatch[1]!);
      const items: AdfNode[] = [];
      while (i < lines.length) {
        const m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        const text = m[2]!.replace(/^\[( |x|X)\]\s+/, (_s, c: string) => (c.trim() ? '☑ ' : '☐ '));
        items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inlineToAdf(text) }] });
        i++;
      }
      content.push({ type: ordered ? 'orderedList' : 'bulletList', content: items });
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushParagraph();
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) quote.push(lines[i++]!.replace(/^>\s?/, ''));
      content.push({ type: 'blockquote', content: [{ type: 'paragraph', content: inlineToAdf(quote.join(' ')) }] });
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      i++;
      continue;
    }
    paragraph.push(line.trim());
    i++;
  }
  flushParagraph();
  return { type: 'doc', version: 1, content: content.length ? content : [{ type: 'paragraph', content: [] }] };
}

/** ADF → plain text (for reading ticket descriptions into LLM context). */
export function adfToText(node: unknown): string {
  if (!node || typeof node !== 'object') return typeof node === 'string' ? node : '';
  const n = node as AdfNode;
  if (n.type === 'text') return n.text ?? '';
  const inner = (n.content ?? []).map(adfToText).join(n.type === 'doc' ? '\n' : '');
  switch (n.type) {
    case 'paragraph':
      return `${inner}\n`;
    case 'heading':
      return `${'#'.repeat(Number(n.attrs?.level ?? 1))} ${inner}\n`;
    case 'listItem':
      return `- ${inner.trim()}\n`;
    case 'codeBlock':
      return `\`\`\`\n${inner}\n\`\`\`\n`;
    case 'hardBreak':
      return '\n';
    default:
      return inner;
  }
}

/**
 * Markdown ⇄ Notion block conversion for documentation publishing.
 */

export interface NotionRichText {
  type: 'text';
  text: { content: string; link?: { url: string } | null };
  annotations?: { bold?: boolean; italic?: boolean; code?: boolean; strikethrough?: boolean };
  plain_text?: string;
  href?: string | null;
}

export type NotionBlock = { object?: 'block'; type: string; id?: string; has_children?: boolean } & Record<string, unknown>;

const MAX_TEXT = 1900;
const NOTION_LANGUAGES = new Set([
  'bash', 'c', 'c#', 'c++', 'css', 'diff', 'docker', 'go', 'graphql', 'html', 'java', 'javascript', 'json', 'kotlin',
  'makefile', 'markdown', 'mermaid', 'php', 'plain text', 'python', 'ruby', 'rust', 'scala', 'shell', 'sql', 'swift', 'typescript', 'yaml',
]);
const LANG_ALIASES: Record<string, string> = { ts: 'typescript', js: 'javascript', sh: 'shell', yml: 'yaml', py: 'python', tsx: 'typescript', jsx: 'javascript', md: 'markdown', text: 'plain text', '': 'plain text' };

function chunk(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += MAX_TEXT) out.push(text.slice(i, i + MAX_TEXT));
  return out.length ? out : [''];
}

const INLINE_RE = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)|\*([^*]+)\*|_([^_]+)_|~~([^~]+)~~)/g;

export function richText(text: string): NotionRichText[] {
  const parts: NotionRichText[] = [];
  const push = (content: string, annotations: NotionRichText['annotations'] = {}, link?: string) => {
    for (const c of chunk(content)) {
      if (!c) continue;
      parts.push({ type: 'text', text: { content: c, ...(link && /^https?:\/\//.test(link) ? { link: { url: link } } : {}) }, annotations });
    }
  };
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) push(text.slice(last, idx));
    if (m[2]) push(m[2], { bold: true });
    else if (m[3]) push(m[3], { code: true });
    else if (m[4] && m[5]) push(m[4], {}, m[5]);
    else if (m[6] ?? m[7]) push((m[6] ?? m[7])!, { italic: true });
    else if (m[8]) push(m[8], { strikethrough: true });
    last = idx + m[0].length;
  }
  if (last < text.length) push(text.slice(last));
  return parts;
}

const block = (type: string, payload: Record<string, unknown>): NotionBlock => ({ object: 'block', type, [type]: payload });

export function markdownToBlocks(markdown: string): NotionBlock[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const blocks: NotionBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) {
      blocks.push(block('paragraph', { rich_text: richText(para.join(' ')) }));
      para = [];
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```([\w#+ -]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i]!)) code.push(lines[i++]!);
      const raw = (fence[1] ?? '').trim().toLowerCase();
      const language = LANG_ALIASES[raw] ?? (NOTION_LANGUAGES.has(raw) ? raw : 'plain text');
      blocks.push(block('code', { language, rich_text: chunk(code.join('\n')).map((c) => ({ type: 'text', text: { content: c } })) }));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = Math.min(3, h[1]!.length);
      blocks.push(block(`heading_${level}`, { rich_text: richText(h[2]!.trim()) }));
      continue;
    }
    if (/^\s*(---|\*\*\*)\s*$/.test(line)) {
      flush();
      blocks.push(block('divider', {}));
      continue;
    }
    const todo = /^\s*[-*]\s+\[( |x|X)\]\s+(.*)$/.exec(line);
    if (todo) {
      flush();
      blocks.push(block('to_do', { checked: todo[1]!.trim() !== '', rich_text: richText(todo[2]!) }));
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      flush();
      blocks.push(block('bulleted_list_item', { rich_text: richText(bullet[1]!) }));
      continue;
    }
    const num = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (num) {
      flush();
      blocks.push(block('numbered_list_item', { rich_text: richText(num[1]!) }));
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flush();
      blocks.push(block('quote', { rich_text: richText(quote[1]!) }));
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return blocks;
}

function plain(rt: unknown): string {
  if (!Array.isArray(rt)) return '';
  return rt
    .map((r: NotionRichText) => {
      const t = r.plain_text ?? r.text?.content ?? '';
      if (r.annotations?.code) return `\`${t}\``;
      if (r.annotations?.bold) return `**${t}**`;
      if (r.annotations?.italic) return `_${t}_`;
      const href = r.href ?? r.text?.link?.url;
      return href ? `[${t}](${href})` : t;
    })
    .join('');
}

export function blocksToMarkdown(blocks: NotionBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const data = (b[b.type] ?? {}) as { rich_text?: unknown; language?: string; checked?: boolean };
    const text = plain(data.rich_text);
    switch (b.type) {
      case 'heading_1':
        out.push(`# ${text}`);
        break;
      case 'heading_2':
        out.push(`## ${text}`);
        break;
      case 'heading_3':
        out.push(`### ${text}`);
        break;
      case 'bulleted_list_item':
        out.push(`- ${text}`);
        break;
      case 'numbered_list_item':
        out.push(`1. ${text}`);
        break;
      case 'to_do':
        out.push(`- [${data.checked ? 'x' : ' '}] ${text}`);
        break;
      case 'quote':
        out.push(`> ${text}`);
        break;
      case 'code':
        out.push(`\`\`\`${data.language ?? ''}\n${text.replace(/^`|`$/g, '')}\n\`\`\``);
        break;
      case 'divider':
        out.push('---');
        break;
      default:
        if (text) out.push(text);
    }
  }
  return out.join('\n\n');
}

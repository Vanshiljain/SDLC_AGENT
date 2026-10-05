import { useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { cn } from '@/lib/cn';

export function MarkdownView({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cn('prose-fl', className)}>
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children: c }) => (
            <a href={href} target={href?.startsWith('/') ? undefined : '_blank'} rel="noreferrer noopener">
              {c}
            </a>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

export function CopyButton({ value, className, label = 'Copy' }: { value: string; className?: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      className={cn('inline-flex items-center gap-1 rounded-sm p-1 text-fg-subtle hover:bg-sunken hover:text-fg', className)}
      onClick={() => {
        void navigator.clipboard.writeText(value).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
    </button>
  );
}

/** Collapsible, syntax-tinted JSON viewer for step inputs/outputs. */
export function JsonView({ value, className, maxHeight = 360 }: { value: unknown; className?: string; maxHeight?: number }) {
  const text = JSON.stringify(value, null, 2) ?? 'null';
  return (
    <div className={cn('group relative rounded-md border border-line bg-sunken', className)}>
      <CopyButton value={text} className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100" />
      <pre className="overflow-auto p-3 font-mono text-[11.5px] leading-[1.6]" style={{ maxHeight }}>
        <code dangerouslySetInnerHTML={{ __html: highlightJson(text) }} />
      </pre>
    </div>
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function highlightJson(json: string): string {
  return escapeHtml(json).replace(/("(?:\\u[a-fA-F0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)/g, (m) => {
    let cls = 'text-arc';
    if (m.startsWith('"')) cls = m.endsWith(':') ? 'text-fg-muted' : 'text-ok';
    else if (m === 'true' || m === 'false') cls = 'text-ai';
    else if (m === 'null') cls = 'text-fg-subtle';
    return `<span class="${cls}">${m}</span>`;
  });
}

export function Disclosure({ title, children, defaultOpen = false, className }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={className}>
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 py-1 text-left text-[12px] font-medium text-fg-muted hover:text-fg" aria-expanded={open}>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        {title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

/** Renders unified diff text with add/remove tinting. */
export function DiffView({ diff, className }: { diff: string; className?: string }) {
  return (
    <pre className={cn('overflow-auto rounded-md border border-line bg-sunken py-2 font-mono text-[11.5px] leading-[1.55]', className)}>
      {diff.split('\n').map((line, i) => (
        <div
          key={i}
          className={cn(
            'px-3 whitespace-pre',
            line.startsWith('+') && !line.startsWith('+++') && 'bg-ok-soft text-ok',
            line.startsWith('-') && !line.startsWith('---') && 'bg-bad-soft text-bad',
            line.startsWith('@@') && 'text-arc',
            (line.startsWith('diff ') || line.startsWith('+++') || line.startsWith('---')) && 'font-semibold text-fg-muted',
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

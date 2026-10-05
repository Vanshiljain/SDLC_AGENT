import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { initials } from '@/lib/format';

export function Card({ className, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-lg border border-line bg-surface shadow-card', className)} {...rest} />;
}

export function CardHeader({
  title,
  description,
  actions,
  className,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-3 px-4 pt-3.5 pb-2.5', className)}>
      <div className="flex min-w-0 items-center gap-2">
        {icon && <span className="text-fg-subtle">{icon}</span>}
        <div className="min-w-0">
          <h3 className="truncate text-[13px] font-semibold tracking-tight">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
        </div>
      </div>
      {actions && <div className="flex shrink-0 items-center gap-1.5">{actions}</div>}
    </div>
  );
}

type Tone = 'neutral' | 'accent' | 'arc' | 'ok' | 'warn' | 'bad' | 'ai';
const TONES: Record<Tone, string> = {
  neutral: 'bg-sunken text-fg-muted border-line',
  accent: 'bg-accent-soft text-accent border-transparent',
  arc: 'bg-arc-soft text-arc border-transparent',
  ok: 'bg-ok-soft text-ok border-transparent',
  warn: 'bg-warn-soft text-warn border-transparent',
  bad: 'bg-bad-soft text-bad border-transparent',
  ai: 'bg-ai-soft text-ai border-transparent',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
  icon,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; icon?: ReactNode }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-sm border px-1.5 text-[11px] font-medium whitespace-nowrap',
        TONES[tone],
        className,
      )}
      {...rest}
    >
      {icon}
      {children}
    </span>
  );
}
export type { Tone };

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line bg-sunken px-1 font-mono text-[10.5px] text-fg-muted',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-label="Loading"
      role="status"
      className={cn(
        'inline-block size-4 animate-spin rounded-full border-[1.5px] border-current border-r-transparent opacity-80',
        className,
      )}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-sunken', className)} />;
}

export function Avatar({ name, size = 24, className }: { name?: string | null; size?: number; className?: string }) {
  const hue = [...(name ?? '?')].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);
  return (
    <span
      title={name ?? undefined}
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white/95 ring-1 ring-black/10',
        className,
      )}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, size * 0.38),
        background: `linear-gradient(135deg, oklch(0.62 0.13 ${hue}), oklch(0.48 0.12 ${(hue + 40) % 360}))`,
      }}
    >
      {initials(name)}
    </span>
  );
}

export function Separator({ className, vertical }: { className?: string; vertical?: boolean }) {
  return <div role="separator" className={cn(vertical ? 'w-px self-stretch bg-line' : 'h-px w-full bg-line', className)} />;
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-[12px] text-fg-muted', className)}>{children}</span>;
}

export function ExternalLink({ href, children, className }: { href: string | null | undefined; children: ReactNode; className?: string }) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener" className={cn('text-fg hover:text-accent hover:underline', className)}>
      {children}
    </a>
  );
}

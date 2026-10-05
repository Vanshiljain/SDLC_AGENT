import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export function PageHeader({ title, description, actions, eyebrow, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-end justify-between gap-4 pb-5', className)}>
      <div className="min-w-0">
        {eyebrow && <div className="label-caps mb-1.5">{eyebrow}</div>}
        <h1 className="text-[22px] leading-tight font-semibold tracking-[-0.02em]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[13px] text-fg-muted">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, className, wide }: { children: ReactNode; className?: string; wide?: boolean }) {
  return <div className={cn('mx-auto w-full px-4 py-6 sm:px-6 lg:px-8', wide ? 'max-w-[1600px]' : 'max-w-[1240px]', className)}>{children}</div>;
}

export function EmptyState({ icon, title, description, action, className, compact }: { icon?: ReactNode; title: ReactNode; description?: ReactNode; action?: ReactNode; className?: string; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col items-center justify-center text-center', compact ? 'px-4 py-8' : 'px-6 py-14', className)}>
      {icon && (
        <div className="relative mb-4">
          <div className="absolute inset-0 rounded-xl bg-accent/20 blur-xl" />
          <div className="relative flex size-11 items-center justify-center rounded-xl border border-line bg-raised text-fg-muted shadow-card [&>svg]:size-5">{icon}</div>
        </div>
      )}
      <h3 className="text-[14px] font-semibold tracking-tight">{title}</h3>
      {description && <p className="mt-1.5 max-w-sm text-[12.5px] leading-relaxed text-fg-muted">{description}</p>}
      {action && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  return (
    <div className="rounded-lg border border-bad/30 bg-bad-soft px-4 py-3 text-[13px] text-bad">
      <div className="font-medium">Couldn’t load this view</div>
      <div className="mt-0.5 text-bad/80">{message}</div>
      {onRetry && (
        <button type="button" onClick={onRetry} className="mt-2 text-[12px] font-medium underline underline-offset-2">
          Try again
        </button>
      )}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone, className }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'accent' | 'ok' | 'bad' | 'warn' | 'arc'; className?: string }) {
  const toneCls = tone ? { accent: 'text-accent', ok: 'text-ok', bad: 'text-bad', warn: 'text-warn', arc: 'text-arc' }[tone] : 'text-fg';
  return (
    <div className={cn('min-w-0 px-4 py-3.5', className)}>
      <div className="flex items-center gap-1.5 text-[11.5px] font-medium text-fg-muted [&>svg]:size-3.5">
        {icon}
        {label}
      </div>
      <div className={cn('mt-1.5 font-mono text-[22px] leading-none font-medium tracking-tight tabular-nums', toneCls)}>{value}</div>
      {hint && <div className="mt-1.5 truncate text-[11.5px] text-fg-subtle">{hint}</div>}
    </div>
  );
}

export function Section({ title, actions, children, className }: { title: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn('space-y-3', className)}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="label-caps">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

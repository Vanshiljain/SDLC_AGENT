import type { ReactNode } from 'react';
import * as Tabs from '@radix-ui/react-tabs';
import { cn } from '@/lib/cn';

export const TabsRoot = Tabs.Root;
export const TabsContent = Tabs.Content;

export function TabsList({ tabs, className }: { tabs: { value: string; label: ReactNode; count?: number | null }[]; className?: string }) {
  return (
    <Tabs.List className={cn('flex items-center gap-4 border-b border-line', className)}>
      {tabs.map((t) => (
        <Tabs.Trigger
          key={t.value}
          value={t.value}
          className="relative -mb-px flex h-9 items-center gap-1.5 border-b-2 border-transparent text-[13px] font-medium text-fg-muted transition-colors hover:text-fg data-[state=active]:border-accent data-[state=active]:text-fg"
        >
          {t.label}
          {t.count !== undefined && t.count !== null && (
            <span className="rounded-sm bg-sunken px-1 font-mono text-[10.5px] text-fg-subtle">{t.count}</span>
          )}
        </Tabs.Trigger>
      ))}
    </Tabs.List>
  );
}

/** Compact segmented control for filters. */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cn('inline-flex h-7 items-center rounded-md border border-line bg-sunken p-0.5', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'h-full rounded-sm px-2.5 text-[12px] font-medium transition-colors',
            value === o.value ? 'bg-raised text-fg shadow-card' : 'text-fg-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

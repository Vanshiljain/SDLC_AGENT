import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/cn';
import { Button } from './button';
import { Skeleton } from './primitives';

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('overflow-x-auto', className)}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}

export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cn('h-8 border-b border-line px-3 text-left text-[11px] font-semibold tracking-wide whitespace-nowrap text-fg-subtle uppercase first:pl-4 last:pr-4', className)}>{children}</th>;
}

export function Td({ children, className, colSpan }: { children?: ReactNode; className?: string; colSpan?: number }) {
  return (
    <td colSpan={colSpan} className={cn('h-11 border-b border-line px-3 align-middle first:pl-4 last:pr-4', className)}>
      {children}
    </td>
  );
}

export function Tr({ children, onClick, className, active }: { children: ReactNode; onClick?: () => void; className?: string; active?: boolean }) {
  return (
    <tr
      onClick={onClick}
      onKeyDown={onClick ? (e) => e.key === 'Enter' && onClick() : undefined}
      tabIndex={onClick ? 0 : undefined}
      className={cn('transition-colors last:[&>td]:border-b-0', onClick && 'cursor-pointer hover:bg-sunken/70 focus-visible:bg-sunken', active && 'bg-sunken', className)}
    >
      {children}
    </tr>
  );
}

export function TableSkeleton({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r}>
          {Array.from({ length: cols }, (_, c) => (
            <Td key={c}>
              <Skeleton className={cn('h-3.5', c === 0 ? 'w-48' : 'w-20')} />
            </Td>
          ))}
        </tr>
      ))}
    </>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="flex items-center justify-between border-t border-line px-4 py-2.5 text-[12px] text-fg-muted">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total}
      </span>
      <div className="flex items-center gap-1">
        <Button size="icon-sm" variant="ghost" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)} icon={<ChevronLeft className="size-4" />} />
        <span className="px-1 font-mono">
          {page}/{pages}
        </span>
        <Button size="icon-sm" variant="ghost" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)} icon={<ChevronRight className="size-4" />} />
      </div>
    </div>
  );
}

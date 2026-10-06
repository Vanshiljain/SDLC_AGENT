import { cn } from '@/lib/cn';
import { BRAND } from '@forgeline/shared';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn('size-7', className)} aria-hidden>
      <rect width="32" height="32" rx="8" className="fill-[#141518] dark:fill-[#1b1c20]" />
      <path d="M8 22.5h16" stroke="#FF6A3D" strokeWidth="2.6" strokeLinecap="round" />
      <path d="M10 17.5l6-8 6 8" fill="none" stroke="#FFB38A" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <span className={cn('flex items-center gap-2', className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-[-0.02em]">{BRAND.name}</span>
    </span>
  );
}

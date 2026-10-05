import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { Spinner } from './primitives';

const VARIANTS = {
  primary:
    'bg-accent text-accent-fg hover:brightness-110 active:brightness-95 shadow-[0_0_0_1px_rgb(0_0_0/0.08),0_6px_18px_-8px_var(--color-accent)]',
  secondary: 'bg-raised text-fg border border-line hover:border-line-strong hover:bg-sunken',
  ghost: 'text-fg-muted hover:text-fg hover:bg-sunken',
  danger: 'bg-bad text-white hover:brightness-110',
  'danger-ghost': 'text-bad hover:bg-bad-soft',
  ok: 'bg-ok text-white hover:brightness-110 dark:text-[#04130b]',
} as const;
const SIZES = {
  xs: 'h-6 px-2 text-[11.5px] gap-1 rounded-sm',
  sm: 'h-7 px-2.5 text-[12.5px] gap-1.5 rounded-sm',
  md: 'h-8 px-3 text-[13px] gap-2 rounded-md',
  lg: 'h-10 px-4 text-sm gap-2 rounded-md',
  icon: 'h-8 w-8 rounded-md justify-center',
  'icon-sm': 'h-7 w-7 rounded-sm justify-center',
} as const;

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  loading?: boolean;
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      className={cn(
        'inline-flex shrink-0 items-center font-medium whitespace-nowrap transition-[background,color,border,filter,box-shadow] duration-150 select-none disabled:pointer-events-none disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      )}
      {...rest}
    >
      {loading ? <Spinner className="size-3.5" /> : icon}
      {children}
    </button>
  );
});

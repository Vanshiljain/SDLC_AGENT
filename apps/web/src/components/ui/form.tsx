import { forwardRef, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/cn';

const field =
  'w-full rounded-md border border-line bg-surface px-2.5 text-[13px] text-fg placeholder:text-fg-subtle transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement> & { icon?: ReactNode }>(function Input(
  { className, icon, ...rest },
  ref,
) {
  if (!icon) return <input ref={ref} className={cn(field, 'h-8', className)} {...rest} />;
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-fg-subtle">{icon}</span>
      <input ref={ref} className={cn(field, 'h-8 pl-8', className)} {...rest} />
    </div>
  );
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...rest },
  ref,
) {
  return <textarea ref={ref} className={cn(field, 'min-h-20 py-2 leading-relaxed', className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select ref={ref} className={cn(field, 'h-8 appearance-none pr-8', className)} {...rest}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-fg-subtle" />
    </div>
  );
});

export function Field({
  label,
  hint,
  error,
  children,
  className,
  required,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  required?: boolean;
}) {
  return (
    <label className={cn('block space-y-1.5', className)}>
      <span className="block text-[12px] font-medium text-fg-muted">
        {label}
        {required && <span className="ml-0.5 text-accent">*</span>}
      </span>
      {children}
      {error ? (
        <span className="block text-[11.5px] text-bad">{error}</span>
      ) : hint ? (
        <span className="block text-[11.5px] text-fg-subtle">{hint}</span>
      ) : null}
    </label>
  );
}

export function Switch({
  checked,
  onCheckedChange,
  disabled,
  label,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <SwitchPrimitive.Root
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
      aria-label={label}
      className="relative inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-line bg-sunken transition-colors data-[state=checked]:border-accent data-[state=checked]:bg-accent disabled:opacity-50"
    >
      <SwitchPrimitive.Thumb className="block size-3 translate-x-[2px] rounded-full bg-fg-muted shadow transition-transform data-[state=checked]:translate-x-[15px] data-[state=checked]:bg-white" />
    </SwitchPrimitive.Root>
  );
}

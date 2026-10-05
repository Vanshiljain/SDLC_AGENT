import type { ReactNode } from 'react';
import * as M from '@radix-ui/react-dropdown-menu';
import * as T from '@radix-ui/react-tooltip';
import * as P from '@radix-ui/react-popover';
import { cn } from '@/lib/cn';

export const Menu = M.Root;
export const MenuTrigger = M.Trigger;

export function MenuContent({ children, align = 'end', className }: { children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string }) {
  return (
    <M.Portal>
      <M.Content align={align} sideOffset={6} className={cn('z-50 min-w-48 rounded-lg border border-line bg-raised p-1 shadow-pop data-[state=open]:animate-fade-in', className)}>
        {children}
      </M.Content>
    </M.Portal>
  );
}

export function MenuItem({ children, onSelect, icon, danger, disabled }: { children: ReactNode; onSelect?: () => void; icon?: ReactNode; danger?: boolean; disabled?: boolean }) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn('flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] outline-none data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[highlighted]:bg-sunken', danger ? 'text-bad' : 'text-fg')}
    >
      {icon && <span className="text-fg-subtle [&>svg]:size-3.5">{icon}</span>}
      {children}
    </M.Item>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <M.Label className="label-caps px-2 pt-2 pb-1">{children}</M.Label>;
}

export function MenuSeparator() {
  return <M.Separator className="my-1 h-px bg-line" />;
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <T.Root delayDuration={250}>
      <T.Trigger asChild>{children}</T.Trigger>
      <T.Portal>
        <T.Content side={side} sideOffset={6} className="z-[60] max-w-xs rounded-md border border-line bg-raised px-2 py-1 text-[11.5px] text-fg shadow-pop data-[state=delayed-open]:animate-fade-in">
          {content}
        </T.Content>
      </T.Portal>
    </T.Root>
  );
}
export const TooltipProvider = T.Provider;

export function Popover({ trigger, children, align = 'end', className, open, onOpenChange }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end' | 'center'; className?: string; open?: boolean; onOpenChange?: (o: boolean) => void }) {
  return (
    <P.Root open={open} onOpenChange={onOpenChange}>
      <P.Trigger asChild>{trigger}</P.Trigger>
      <P.Portal>
        <P.Content align={align} sideOffset={8} className={cn('z-50 rounded-lg border border-line bg-raised shadow-pop data-[state=open]:animate-fade-in', className)}>
          {children}
        </P.Content>
      </P.Portal>
    </P.Root>
  );
}

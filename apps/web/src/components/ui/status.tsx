import type { ReactNode } from 'react';
import { AlertTriangle, Ban, Check, CircleDashed, Clock, FlaskConical, Hand, Loader2, Pause, RotateCcw, SkipForward, Undo2, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { titleCase } from '@/lib/format';
import { Badge, type Tone } from './primitives';
import { Tooltip } from './menu';

/** One visual language for every lifecycle status in the product. */
interface StatusStyle {
  tone: Tone;
  label?: string;
  icon: ReactNode;
  live?: boolean;
}

const STATUS: Record<string, StatusStyle> = {
  // executions & steps
  PENDING: { tone: 'neutral', icon: <CircleDashed /> },
  QUEUED: { tone: 'neutral', icon: <Clock /> },
  RUNNING: { tone: 'arc', icon: <Loader2 className="animate-spin" />, live: true },
  RETRYING: { tone: 'warn', icon: <RotateCcw />, live: true },
  RETRY_SCHEDULED: { tone: 'warn', label: 'Retry scheduled', icon: <RotateCcw />, live: true },
  REPAIRING: { tone: 'ai', icon: <FlaskConical />, live: true },
  WAITING_APPROVAL: { tone: 'accent', label: 'Awaiting approval', icon: <Hand />, live: true },
  WAITING: { tone: 'neutral', icon: <Clock />, live: true },
  PAUSED: { tone: 'warn', icon: <Pause /> },
  COMPLETED: { tone: 'ok', icon: <Check /> },
  SUCCEEDED: { tone: 'ok', icon: <Check /> },
  PASSED: { tone: 'ok', icon: <Check /> },
  FAILED: { tone: 'bad', icon: <X /> },
  ERROR: { tone: 'bad', icon: <AlertTriangle /> },
  CANCELLED: { tone: 'neutral', icon: <Ban /> },
  SKIPPED: { tone: 'neutral', icon: <SkipForward /> },
  COMPENSATING: { tone: 'warn', label: 'Rolling back', icon: <Undo2 />, live: true },
  COMPENSATED: { tone: 'warn', label: 'Rolled back', icon: <Undo2 /> },
  ROLLED_BACK: { tone: 'warn', label: 'Rolled back', icon: <Undo2 /> },
  ROLLING_BACK: { tone: 'warn', label: 'Rolling back', icon: <Undo2 />, live: true },
  DEPLOYING: { tone: 'arc', icon: <Loader2 className="animate-spin" />, live: true },
  IN_PROGRESS: { tone: 'arc', label: 'In progress', icon: <Loader2 className="animate-spin" />, live: true },
  AWAITING_APPROVAL: { tone: 'accent', label: 'Awaiting approval', icon: <Hand />, live: true },
  VERIFYING: { tone: 'arc', icon: <Loader2 className="animate-spin" />, live: true },
  // approvals
  APPROVED: { tone: 'ok', icon: <Check /> },
  REJECTED: { tone: 'bad', icon: <X /> },
  EXPIRED: { tone: 'neutral', icon: <Clock /> },
  // integrations
  CONNECTED: { tone: 'ok', icon: <Check /> },
  DISCONNECTED: { tone: 'neutral', icon: <Ban /> },
  HEALTHY: { tone: 'ok', icon: <Check /> },
  DEGRADED: { tone: 'warn', icon: <AlertTriangle /> },
  UNHEALTHY: { tone: 'bad', icon: <X /> },
  UNKNOWN: { tone: 'neutral', icon: <CircleDashed /> },
  INDEXED: { tone: 'ok', icon: <Check /> },
  PROCESSING: { tone: 'arc', icon: <Loader2 className="animate-spin" />, live: true },
};

export function statusTone(status: string | null | undefined): Tone {
  return STATUS[status ?? '']?.tone ?? 'neutral';
}

export function isLive(status: string | null | undefined): boolean {
  return Boolean(STATUS[status ?? '']?.live);
}

export function StatusBadge({ status, className, label }: { status: string; className?: string; label?: string }) {
  const s: StatusStyle = STATUS[status] ?? { tone: 'neutral', icon: <CircleDashed /> };
  return (
    <Badge tone={s.tone} className={cn('[&_svg]:size-3', className)} icon={s.icon}>
      {label ?? s.label ?? titleCase(status)}
    </Badge>
  );
}

const DOT: Record<Tone, string> = {
  neutral: 'bg-fg-subtle text-fg-subtle',
  accent: 'bg-accent text-accent',
  arc: 'bg-arc text-arc',
  ok: 'bg-ok text-ok',
  warn: 'bg-warn text-warn',
  bad: 'bg-bad text-bad',
  ai: 'bg-ai text-ai',
};

export function StatusDot({ status, className, title }: { status: string; className?: string; title?: string }) {
  const tone = statusTone(status);
  return <span title={title ?? titleCase(status)} className={cn('inline-block size-2 shrink-0 rounded-full', DOT[tone], isLive(status) && 'animate-pulse-dot', className)} />;
}

export function ModeBadge({ mode, className }: { mode: string; className?: string }) {
  if (mode !== 'DEMO') return null;
  return (
    <Tooltip content="Simulated run in a demo workspace. No external system was changed.">
      <span className={cn('demo-stripes inline-flex h-5 items-center rounded-sm border border-warn/40 px-1.5 text-[10.5px] font-semibold tracking-wide text-warn uppercase', className)}>Simulated</span>
    </Tooltip>
  );
}

const RISK: Record<string, Tone> = { LOW: 'ok', MEDIUM: 'warn', HIGH: 'accent', CRITICAL: 'bad' };
export function RiskBadge({ level, className }: { level: string | null | undefined; className?: string }) {
  if (!level) return null;
  return (
    <Badge tone={RISK[level] ?? 'neutral'} className={className}>
      {titleCase(level)} risk
    </Badge>
  );
}

/** Segmented step progress with the molten forge line on the active segment. */
export function ForgeProgress({ steps, className }: { steps: { status: string; key?: string; name?: string }[]; className?: string }) {
  const visible = steps.filter((s) => s.status !== 'SKIPPED');
  if (!visible.length) return null;
  return (
    <div className={cn('flex h-1.5 w-full gap-[3px]', className)}>
      {visible.map((s, i) => {
        const tone = statusTone(s.status);
        const live = isLive(s.status);
        return (
          <Tooltip key={s.key ?? i} content={s.name ? `${s.name} · ${titleCase(s.status)}` : undefined}>
            <span
              className={cn(
                'h-full min-w-1 flex-1 rounded-full',
                live ? 'forge-line' : tone === 'ok' ? 'bg-ok/80' : tone === 'bad' ? 'bg-bad' : tone === 'warn' ? 'bg-warn/80' : tone === 'accent' ? 'bg-accent/70' : 'bg-line-strong/70',
              )}
            />
          </Tooltip>
        );
      })}
    </div>
  );
}

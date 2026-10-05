import { Link, useNavigate } from 'react-router';
import { AlertTriangle, ArrowUpRight, BookOpen, Check, FileText, Hand, Loader2, Play, Plug, ShieldCheck, Wrench, X } from 'lucide-react';
import type { FlowProposalPart, MessagePart, RunCardPart, SourcesPart, ToolCallPart } from '@forgeline/shared';
import { TERMINAL_EXECUTION_STATUSES } from '@forgeline/shared';
import { api } from '@/api/client';
import { qk, useAction, useExecution } from '@/api/queries';
import type { Message } from '@/api/types';
import { cn } from '@/lib/cn';
import { titleCase, providerName } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/ui/content';
import { Badge } from '@/components/ui/primitives';
import { ForgeProgress, ModeBadge, StatusBadge, StatusDot } from '@/components/ui/status';

export function MessageParts({ message, conversationId, compact }: { message: Message; conversationId: string; compact?: boolean }) {
  const parts = message.parts ?? [];
  const tools = parts.filter((p): p is ToolCallPart => p.type === 'tool_call');
  return (
    <div className="space-y-3">
      {tools.length > 0 && <ToolCalls tools={tools} />}
      {parts.map((part, i) => (
        <Part key={i} part={part} conversationId={conversationId} compact={compact} />
      ))}
    </div>
  );
}

function Part({ part, conversationId, compact }: { part: MessagePart; conversationId: string; compact?: boolean }) {
  switch (part.type) {
    case 'text':
      return part.text.trim() ? <MarkdownView>{part.text}</MarkdownView> : null;
    case 'flow_proposal':
      return <ProposalCard part={part} conversationId={conversationId} compact={compact} />;
    case 'run':
      return <RunCard part={part} />;
    case 'sources':
      return <Sources part={part} />;
    case 'artifact':
      return (
        <div className="flex items-center gap-2 rounded-md border border-line bg-raised px-3 py-2 text-[12.5px]">
          <FileText className="size-4 text-fg-subtle" />
          <span className="flex-1 truncate font-medium">{part.title}</span>
          <Badge>{titleCase(part.artifactType)}</Badge>
        </div>
      );
    case 'approval':
      return (
        <Link
          to={`/approvals/${part.approvalId}`}
          className="flex items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-[12.5px] hover:border-accent/60"
        >
          <Hand className="size-4 text-accent" />
          <span className="flex-1 truncate font-medium">{part.title}</span>
          <span className="text-accent">Review →</span>
        </Link>
      );
    case 'entity':
      return (
        <Link
          to={entityLink(part.kind, part.id)}
          className="inline-flex items-center gap-1.5 rounded-md border border-line bg-raised px-2.5 py-1.5 text-[12.5px] hover:border-line-strong"
        >
          {part.title}
          <ArrowUpRight className="size-3.5 text-fg-subtle" />
        </Link>
      );
    case 'error':
      return (
        <div className="flex items-start gap-2 rounded-md border border-bad/30 bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>{part.message}</span>
        </div>
      );
    case 'tool_call':
      return null;
    default:
      return null;
  }
}

function entityLink(kind: string, id: string): string {
  const map: Record<string, string> = {
    deployment: '/deployments',
    code_review: '/code-reviews',
    qa_run: '/qa',
    code_generation: '/executions',
    document: '/documents',
    task: '/tasks',
  };
  return kind === 'code_review' || kind === 'document' ? `${map[kind]}/${id}` : (map[kind] ?? '/dashboard');
}

export function ToolCalls({ tools }: { tools: ToolCallPart[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {tools.map((t) => (
        <span
          key={t.callId}
          title={t.summary}
          className={cn(
            'inline-flex h-6 items-center gap-1.5 rounded-sm border px-2 text-[11.5px]',
            t.status === 'failed' ? 'border-bad/30 bg-bad-soft text-bad' : 'border-line bg-sunken text-fg-muted',
          )}
        >
          {t.status === 'running' ? (
            <Loader2 className="size-3 animate-spin text-arc" />
          ) : t.status === 'failed' ? (
            <X className="size-3" />
          ) : (
            <Wrench className="size-3 text-fg-subtle" />
          )}
          {t.title}
        </span>
      ))}
    </div>
  );
}

function ProposalCard({ part, conversationId, compact }: { part: FlowProposalPart; conversationId: string; compact?: boolean }) {
  const navigate = useNavigate();
  const start = useAction(
    () => api.post<{ execution: { id: string } }>(`/conversations/${conversationId}/proposals/${part.proposalId}/start`, {}),
    {
      success: part.mode === 'DEMO' ? 'Flow started (simulated)' : 'Flow started',
      invalidate: [qk.conversation(conversationId), ['executions', 'list']],
      onSuccess: (r) => !compact && navigate(`/executions/${r.execution.id}`),
    },
  );
  const dismiss = useAction(() => api.post(`/conversations/${conversationId}/proposals/${part.proposalId}/dismiss`, {}), {
    invalidate: [qk.conversation(conversationId)],
  });
  const steps = part.steps.filter((s) => s.type !== 'repair');
  const gates = new Set(part.approvalsRequired);
  const blocked = part.missingIntegrations.length > 0;

  return (
    <div className="overflow-hidden rounded-lg border border-line bg-raised shadow-card">
      <div className="relative border-b border-line px-4 py-3">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-accent/70 to-transparent" />
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="label-caps mb-1 text-ai">Proposed flow</div>
            <div className="text-[14px] font-semibold tracking-tight">{part.title}</div>
            <p className="mt-1 text-[12.5px] text-fg-muted">{part.summary}</p>
          </div>
          <ModeBadge mode={part.mode} />
        </div>
      </div>
      <ol className={cn('grid gap-x-4 gap-y-1 px-4 py-3 text-[12.5px]', !compact && 'sm:grid-cols-2')}>
        {steps.map((s, i) => (
          <li key={s.key} className="flex min-w-0 items-center gap-2">
            <span className="w-5 shrink-0 text-right font-mono text-[10.5px] text-fg-subtle">{i + 1}</span>
            <span className="truncate">{s.name}</span>
            {s.requiresApproval && <Hand className="size-3 shrink-0 text-accent" aria-label="Requires approval" />}
          </li>
        ))}
      </ol>
      {(gates.size > 0 || blocked) && (
        <div className="space-y-2 border-t border-line px-4 py-3 text-[12px]">
          {gates.size > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <ShieldCheck className="size-3.5 text-accent" />
              <span className="text-fg-muted">Needs approval:</span>
              {[...gates].map((g) => (
                <Badge key={g} tone="accent">
                  {g}
                </Badge>
              ))}
            </div>
          )}
          {blocked && (
            <div className="flex flex-wrap items-center gap-1.5 text-warn">
              <Plug className="size-3.5" />
              <span>Connect first:</span>
              {part.missingIntegrations.map((m) => (
                <Badge key={m} tone="warn">
                  {providerName(m)}
                </Badge>
              ))}
              <Link to="/integrations" className="ml-1 underline underline-offset-2">
                Integrations
              </Link>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-line bg-sunken/50 px-4 py-2.5">
        {part.state === 'proposed' ? (
          <>
            <Button
              variant="primary"
              size="sm"
              icon={<Play className="size-3.5" />}
              loading={start.isPending}
              disabled={blocked}
              onClick={() => start.mutate(undefined)}
            >
              Start flow
            </Button>
            <Button variant="ghost" size="sm" loading={dismiss.isPending} onClick={() => dismiss.mutate(undefined)}>
              Dismiss
            </Button>
            <span className="ml-auto text-[11.5px] text-fg-subtle">{steps.length} steps</span>
          </>
        ) : part.state === 'started' && part.executionId ? (
          <Link to={`/executions/${part.executionId}`} className="inline-flex items-center gap-1.5 text-[12.5px] font-medium text-ok">
            <Check className="size-3.5" /> Started — open run
          </Link>
        ) : (
          <span className="text-[12px] text-fg-subtle">Dismissed</span>
        )}
      </div>
    </div>
  );
}

function RunCard({ part }: { part: RunCardPart }) {
  const live = useExecution(part.executionId);
  const status = live.data?.status ?? part.status;
  const steps =
    live.data?.steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status })) ??
    part.steps.map((s) => ({ key: s.key, name: s.name, status: s.status }));
  const current = live.data?.steps.find((s) => ['RUNNING', 'WAITING_APPROVAL', 'RETRYING', 'REPAIRING'].includes(s.status));
  const done = TERMINAL_EXECUTION_STATUSES.includes(status);
  return (
    <Link
      to={`/executions/${part.executionId}`}
      className="block rounded-lg border border-line bg-raised px-4 py-3 shadow-card transition-colors hover:border-line-strong"
    >
      <div className="flex items-center gap-2">
        <StatusDot status={status} />
        <span className="flex-1 truncate text-[13px] font-medium">{part.title}</span>
        <ModeBadge mode={part.mode} />
        <StatusBadge status={status} />
      </div>
      <ForgeProgress steps={steps} className="mt-3" />
      <div className="mt-2 flex items-center justify-between text-[11.5px] text-fg-subtle">
        <span className="truncate">
          {done
            ? `${steps.filter((s) => s.status === 'COMPLETED').length} steps completed`
            : current
              ? `${current.name}${current.status === 'WAITING_APPROVAL' ? ' · waiting for approval' : '…'}`
              : 'Starting…'}
        </span>
        <span className="inline-flex items-center gap-1 text-fg-muted">
          Open <ArrowUpRight className="size-3" />
        </span>
      </div>
    </Link>
  );
}

function Sources({ part }: { part: SourcesPart }) {
  if (!part.sources.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
      <BookOpen className="size-3.5 text-fg-subtle" />
      {part.sources.map((s) => (
        <a
          key={s.documentId}
          href={s.url ?? undefined}
          target="_blank"
          rel="noreferrer"
          className="inline-flex h-6 items-center gap-1 rounded-sm border border-line bg-sunken px-2 text-fg-muted hover:text-fg"
        >
          {s.title}
          <span className="font-mono text-[10px] text-fg-subtle">{Math.round(s.score * 100)}%</span>
        </a>
      ))}
    </div>
  );
}

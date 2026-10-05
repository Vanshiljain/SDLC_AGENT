import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowUpRight, Check, CircleMinus, CirclePlus, ExternalLink, FileDiff, GitPullRequest, Lock, RotateCcw, Ticket, X } from 'lucide-react';
import { api } from '@/api/client';
import { qk, useAction, useApproval } from '@/api/queries';
import type { Approval } from '@/api/types';
import { cn } from '@/lib/cn';
import { formatDateTime, timeAgo, titleCase } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/form';
import { Avatar, Badge, Skeleton } from '@/components/ui/primitives';
import { ModeBadge, RiskBadge, StatusBadge } from '@/components/ui/status';

/**
 * Everything an approver needs in one place: what will happen, the evidence
 * (CI, QA, review, changes), an AI risk assessment, and the policy that applies.
 * The server re-checks permissions and four-eyes on every decision.
 */
export function ApprovalReview({ approvalId, onDecided }: { approvalId: string; onDecided?: () => void }) {
  const { data: a, isLoading } = useApproval(approvalId);
  const [comment, setComment] = useState('');
  const decide = useAction((approve: boolean) => api.post<Approval>(`/approvals/${approvalId}/${approve ? 'approve' : 'reject'}`, { comment: comment.trim() || undefined }), {
    success: (r) => (r.status === 'APPROVED' ? 'Approved — the run continues' : 'Rejected — the step will not run'),
    invalidate: [['approvals'], qk.dashboard, ['executions']],
    onSuccess: () => onDecided?.(),
  });

  if (isLoading || !a) {
    return (
      <div className="space-y-3 p-5">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  const ctx = a.context ?? {};
  const ev = ctx.evidence ?? {};
  const risk = ctx.risk;
  const pending = a.status === 'PENDING';

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge status={a.status} />
          <RiskBadge level={a.riskLevel} />
          <Badge tone="neutral" className="font-mono">
            {a.action}
          </Badge>
          {a.execution && <ModeBadge mode={a.execution.mode} />}
          {!a.allowSelfApproval && (
            <Badge tone="ai" icon={<Lock className="size-3" />}>
              Four-eyes
            </Badge>
          )}
        </div>

        {a.description && <p className="text-[13px] leading-relaxed text-fg-muted">{a.description}</p>}

        {a.execution && (
          <Link to={`/executions/${a.execution.id}`} className="flex items-center gap-2 rounded-md border border-line bg-sunken/60 px-3 py-2 text-[12.5px] hover:border-line-strong">
            <span className="text-fg-subtle">Run</span>
            <span className="min-w-0 flex-1 truncate font-medium">{a.execution.title}</span>
            <ArrowUpRight className="size-3.5 text-fg-subtle" />
          </Link>
        )}

        {risk && (
          <section className="rounded-lg border border-line">
            <div className="flex items-center justify-between gap-2 border-b border-line px-3.5 py-2.5">
              <span className="text-[12.5px] font-semibold">Risk assessment</span>
              <span className="flex items-center gap-1.5 text-[11px] text-fg-subtle">
                {risk.source === 'ai' ? 'AI-assisted' : 'Heuristic'} · recommends <span className={cn('font-semibold', risk.recommendation === 'approve' ? 'text-ok' : 'text-warn')}>{risk.recommendation}</span>
              </span>
            </div>
            <div className="space-y-3 px-3.5 py-3">
              <p className="text-[12.5px] text-fg-muted">{risk.summary}</p>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {risk.factors.map((f) => (
                  <li key={f.factor} className="flex items-start gap-1.5 text-[12px]">
                    {f.impact === 'positive' ? <CirclePlus className="mt-0.5 size-3.5 shrink-0 text-ok" /> : f.impact === 'negative' ? <CircleMinus className="mt-0.5 size-3.5 shrink-0 text-bad" /> : <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-fg-subtle" />}
                    <span>{f.factor}</span>
                  </li>
                ))}
              </ul>
              {risk.mitigations.length > 0 && (
                <div className="text-[12px] text-fg-muted">
                  <span className="font-medium text-fg">Mitigations:</span> {risk.mitigations.join(' · ')}
                </div>
              )}
            </div>
          </section>
        )}

        <section>
          <h4 className="label-caps mb-2">Evidence</h4>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <EvidenceTile label="CI" value={ev.ci?.status} />
            <EvidenceTile label="QA" value={ev.qa?.status} detail={ev.qa?.passed !== undefined ? `${ev.qa.passed} passed${ev.qa.failed ? ` · ${ev.qa.failed} failed` : ''}` : undefined} />
            <EvidenceTile label="Review" value={ev.review?.status} detail={ev.review ? `${ev.review.critical ?? 0} critical · ${ev.review.high ?? 0} high` : undefined} />
            <EvidenceTile label="Rollback" value={ev.rollbackReady === undefined ? undefined : ev.rollbackReady ? 'ready' : 'manual'} />
          </div>
          {ev.simulated && <p className="mt-2 text-[11.5px] text-warn">Evidence comes from a simulated (demo) run.</p>}
        </section>

        {(ctx.ticket || ctx.pullRequest || ctx.environment) && (
          <section className="grid gap-2 text-[12.5px] sm:grid-cols-2">
            {ctx.ticket && (
              <LinkTile icon={<Ticket />} label="Ticket" href={ctx.ticket.url}>
                {ctx.ticket.key} {ctx.ticket.summary ? `· ${ctx.ticket.summary}` : ''}
              </LinkTile>
            )}
            {ctx.pullRequest?.number && (
              <LinkTile icon={<GitPullRequest />} label="Pull request" href={ctx.pullRequest.url}>
                #{ctx.pullRequest.number} {ctx.pullRequest.title ?? ''}
              </LinkTile>
            )}
            {ctx.environment && (
              <LinkTile icon={<RotateCcw />} label="Environment" href={null}>
                {ctx.environment}
                {ctx.version ? ` · ${ctx.version}` : ''}
              </LinkTile>
            )}
          </section>
        )}

        {ev.changes && ev.changes.items.length > 0 && (
          <section>
            <h4 className="label-caps mb-2 flex items-center gap-1.5">
              <FileDiff className="size-3" /> Changes · {ev.changes.files} file{ev.changes.files === 1 ? '' : 's'}
            </h4>
            <ul className="space-y-1 rounded-md border border-line bg-sunken/60 p-2.5 font-mono text-[11.5px]">
              {ev.changes.items.map((c) => (
                <li key={c} className="truncate">
                  <span className={c.startsWith('create') ? 'text-ok' : c.startsWith('delete') ? 'text-bad' : 'text-warn'}>{c.split(' ')[0]}</span> {c.split(' ').slice(1).join(' ')}
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="space-y-1.5 text-[12px] text-fg-muted">
          <div className="flex items-center gap-2">
            <span className="w-24 text-fg-subtle">Requested</span>
            {a.requestedBy && <Avatar name={a.requestedBy.name} size={16} />} {a.requestedBy?.name ?? 'System'} · {timeAgo(a.createdAt)}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-24 text-fg-subtle">Needs</span>
            <span className="font-mono">{a.requiredPermission}</span>
          </div>
          {a.expiresAt && pending && (
            <div className="flex items-center gap-2">
              <span className="w-24 text-fg-subtle">Expires</span>
              {formatDateTime(a.expiresAt)}
            </div>
          )}
          {a.decidedBy && (
            <div className="flex items-center gap-2">
              <span className="w-24 text-fg-subtle">{titleCase(a.status)} by</span>
              <Avatar name={a.decidedBy.name} size={16} /> {a.decidedBy.name} · {timeAgo(a.decidedAt)}
            </div>
          )}
          {a.decisionComment && <blockquote className="mt-2 border-l-2 border-line-strong pl-3 text-fg">“{a.decisionComment}”</blockquote>}
        </section>
      </div>

      {pending && (
        <div className="border-t border-line bg-surface p-4">
          {a.canDecide ? (
            <>
              <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Add a comment (optional, recorded in the audit log)" rows={2} className="min-h-0" />
              <div className="mt-3 flex items-center justify-end gap-2">
                <Button variant="danger-ghost" icon={<X className="size-3.5" />} loading={decide.isPending && decide.variables === false} disabled={decide.isPending} onClick={() => decide.mutate(false)}>
                  Reject
                </Button>
                <Button variant="ok" icon={<Check className="size-3.5" />} loading={decide.isPending && decide.variables === true} disabled={decide.isPending} onClick={() => decide.mutate(true)}>
                  Approve
                </Button>
              </div>
            </>
          ) : (
            <div className="flex items-center gap-2 rounded-md bg-sunken px-3 py-2.5 text-[12.5px] text-fg-muted">
              <Lock className="size-3.5 shrink-0" />
              {a.cannotDecideReason ?? 'You can’t decide this approval.'}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function EvidenceTile({ label, value, detail }: { label: string; value?: string | null; detail?: string }) {
  const tone = !value ? 'text-fg-subtle' : ['passed', 'success', 'ready', 'approve'].includes(value) ? 'text-ok' : ['failed', 'failure'].includes(value) ? 'text-bad' : 'text-warn';
  return (
    <div className="rounded-md border border-line bg-raised px-3 py-2">
      <div className="text-[11px] text-fg-subtle">{label}</div>
      <div className={cn('mt-0.5 text-[13px] font-semibold capitalize', tone)}>{value ?? 'n/a'}</div>
      {detail && <div className="mt-0.5 truncate text-[10.5px] text-fg-subtle">{detail}</div>}
    </div>
  );
}

function LinkTile({ icon, label, href, children }: { icon: React.ReactNode; label: string; href: string | null | undefined; children: React.ReactNode }) {
  const inner = (
    <>
      <span className="text-fg-subtle [&>svg]:size-3.5">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-[11px] text-fg-subtle">{label}</span>
        <span className="block truncate">{children}</span>
      </span>
      {href && <ExternalLink className="size-3.5 text-fg-subtle" />}
    </>
  );
  return href ? (
    <a href={href} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md border border-line px-3 py-2 hover:border-line-strong">
      {inner}
    </a>
  ) : (
    <div className="flex items-center gap-2 rounded-md border border-line px-3 py-2">{inner}</div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUpRight, Ban, Bot, Clock, Coins, ExternalLink, FileText, GitBranch, Hand, Pause, Play, Repeat2, RotateCcw, Rows3, TriangleAlert, Undo2, Workflow } from 'lucide-react';
import { TERMINAL_EXECUTION_STATUSES } from '@forgeline/shared';
import { api } from '@/api/client';
import { qk, useAction, useAudit, useExecution, useExecutionLogs } from '@/api/queries';
import type { Artifact, ExecutionDetail, ExecutionLog, ExecutionStep } from '@/api/types';
import { cn } from '@/lib/cn';
import { durationBetween, formatDateTime, formatDuration, formatNumber, shortSha, timeAgo, titleCase, providerName } from '@/lib/format';
import { realtime } from '@/lib/realtime';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { DiffView, Disclosure, JsonView, MarkdownView } from '@/components/ui/content';
import { Dialog, Sheet } from '@/components/ui/dialog';
import { Tooltip } from '@/components/ui/menu';
import { Avatar, Badge, Card, ExternalLink as ExtLink, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page } from '@/components/ui/page';
import { ModeBadge, RiskBadge, StatusBadge, StatusDot, isLive } from '@/components/ui/status';
import { Segmented, TabsContent, TabsList, TabsRoot } from '@/components/ui/tabs';
import { ApprovalReview } from '@/features/approval-review';
import { agentOf, latestSteps, RunGraph } from '@/features/flow-graph';

export function ExecutionDetailPage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const { data: run, isLoading, error, refetch } = useExecution(id);
  const [selectedStep, setSelectedStep] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [artifactId, setArtifactId] = useState<string | null>(null);
  const [direction, setDirection] = useState<'LR' | 'TB'>('LR');
  const [tab, setTab] = useState('timeline');
  useDocumentTitle(run?.title ?? 'Run');
  usePageContext(run ? { title: run.title, entity: { kind: 'execution', id: run.id, label: run.title }, projectId: run.projectId ?? undefined } : null, [run?.id]);

  // Live: join the run's room; append streamed log lines to the cache.
  useEffect(() => {
    if (!id) return;
    const unsub = realtime.subscribe({ executionId: id });
    const off = realtime.on(
      (e) => {
        if (e.executionId !== id) return;
        const d = e.data as unknown as { stepId?: string | null; level: ExecutionLog['level']; message: string; data?: Record<string, unknown> | null; createdAt: string };
        qc.setQueryData<ExecutionLog[]>(qk.executionLogs(id), (old) => [...(old ?? []), { id: e.id, executionId: id, stepId: d.stepId ?? null, level: d.level, message: d.message, data: d.data ?? null, createdAt: d.createdAt ?? e.occurredAt }]);
      },
      ['workflow.log'],
    );
    return () => {
      off();
      unsub();
    };
  }, [id, qc]);

  if (error) return <Page><ErrorState error={error} onRetry={() => void refetch()} /></Page>;
  if (isLoading || !run) return <DetailSkeleton />;

  const pendingApprovals = run.approvals.filter((a) => a.status === 'PENDING');
  const step = selectedStep ? latestSteps(run.steps).get(selectedStep)?.run ?? null : null;

  return (
    <Page wide>
      <Header run={run} />
      {run.mode === 'DEMO' && (
        <div className="demo-stripes mb-4 rounded-lg border border-warn/30 px-4 py-2.5 text-[12.5px] text-warn">
          <span className="font-semibold">Simulated run.</span> This run executed in a demo workspace: every output is labelled as simulated and nothing was created in GitHub, Jira, Notion or your CI/CD.
        </div>
      )}
      {pendingApprovals.map((a) => (
        <button key={a.id} type="button" onClick={() => setApprovalId(a.id)} className="mb-4 flex w-full items-center gap-3 rounded-lg border border-accent/40 bg-accent-soft px-4 py-3 text-left transition-colors hover:border-accent">
          <span className="flex size-8 items-center justify-center rounded-md bg-accent text-accent-fg">
            <Hand className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-semibold">Waiting for approval: {a.title}</span>
            <span className="block truncate text-[12px] text-fg-muted">{a.description}</span>
          </span>
          <RiskBadge level={a.riskLevel} />
          <span className="text-[12.5px] font-medium text-accent">Review →</span>
        </button>
      ))}
      {run.status === 'FAILED' && run.error && <FailureBanner run={run} onSelect={setSelectedStep} />}

      <Card className="overflow-hidden">
        <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2">
          <div className="flex items-center gap-2 text-[12.5px] font-medium">
            <Workflow className="size-4 text-fg-subtle" /> Flow
            <span className="text-[11.5px] font-normal text-fg-subtle">· click a step for details</span>
          </div>
          <Segmented value={direction} onChange={setDirection} options={[{ value: 'LR', label: 'Horizontal' }, { value: 'TB', label: 'Vertical' }]} />
        </div>
        <div className={direction === 'LR' ? 'h-[420px]' : 'h-[640px]'}>
          <RunGraph definition={run.definition} steps={run.steps} direction={direction} selectedKey={selectedStep} onSelect={setSelectedStep} />
        </div>
      </Card>

      <TabsRoot value={tab} onValueChange={setTab} className="mt-6">
        <TabsList
          tabs={[
            { value: 'timeline', label: 'Timeline' },
            { value: 'logs', label: 'Logs' },
            { value: 'outputs', label: 'Outputs', count: run.artifacts.length + run.codeReviews.length + run.qaRuns.length },
            { value: 'effects', label: 'Side effects', count: run.externalResources.length + run.deployments.length },
            { value: 'approvals', label: 'Approvals', count: run.approvals.length },
            { value: 'agents', label: 'Agents & tools', count: run.toolExecutions.length },
            { value: 'audit', label: 'Audit' },
          ]}
        />
        <TabsContent value="timeline" className="pt-4">
          <Timeline run={run} onSelect={setSelectedStep} />
        </TabsContent>
        <TabsContent value="logs" className="pt-4">
          <Logs run={run} />
        </TabsContent>
        <TabsContent value="outputs" className="pt-4">
          <Outputs run={run} onArtifact={setArtifactId} />
        </TabsContent>
        <TabsContent value="effects" className="pt-4">
          <SideEffects run={run} />
        </TabsContent>
        <TabsContent value="approvals" className="pt-4">
          <ApprovalList run={run} onOpen={setApprovalId} />
        </TabsContent>
        <TabsContent value="agents" className="pt-4">
          <AgentsAndTools run={run} />
        </TabsContent>
        <TabsContent value="audit" className="pt-4">
          <RunAudit executionId={run.id} />
        </TabsContent>
      </TabsRoot>

      <StepSheet run={run} step={step} open={Boolean(step)} onClose={() => setSelectedStep(null)} onApproval={setApprovalId} />
      <Sheet open={Boolean(approvalId)} onOpenChange={(o) => !o && setApprovalId(null)} title="Approval" subtitle={run.approvals.find((a) => a.id === approvalId)?.title} width={600}>
        {approvalId && <ApprovalReview approvalId={approvalId} onDecided={() => void refetch()} />}
      </Sheet>
      <ArtifactDialog artifactId={artifactId} onClose={() => setArtifactId(null)} />
    </Page>
  );
}

function DetailSkeleton() {
  return (
    <Page wide>
      <Skeleton className="mb-2 h-4 w-24" />
      <Skeleton className="mb-6 h-8 w-2/3" />
      <Skeleton className="h-[420px]" />
    </Page>
  );
}

function Header({ run }: { run: ExecutionDetail }) {
  const [tick, setTick] = useState(0);
  const terminal = TERMINAL_EXECUTION_STATUSES.includes(run.status);
  useEffect(() => {
    if (terminal) return;
    const t = setInterval(() => setTick((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, [terminal]);
  void tick;
  const visible = run.steps.filter((s) => s.status !== 'SKIPPED');
  const latest = [...latestSteps(run.steps).values()].map((x) => x.run);
  const done = latest.filter((s) => s.status === 'COMPLETED').length;
  const repairs = latest.reduce((n, s) => n + s.iteration, 0);
  return (
    <div className="mb-5">
      <Link to="/executions" className="mb-3 inline-flex items-center gap-1 text-[12px] text-fg-muted hover:text-fg">
        <ArrowLeft className="size-3.5" /> Runs
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={run.status} />
            <ModeBadge mode={run.mode} />
            {run.template && <Badge className="font-mono">{run.template}</Badge>}
          </div>
          <h1 className="mt-2 text-[21px] leading-snug font-semibold tracking-[-0.02em]">{run.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-fg-muted">
            {run.project && (
              <Link to={`/projects/${run.project.id}`} className="hover:text-fg">
                {run.project.name}
              </Link>
            )}
            <span className="flex items-center gap-1.5">
              {run.triggeredBy && <Avatar name={run.triggeredBy.name} size={16} />}
              {run.triggeredBy?.name ?? 'System'} · {titleCase(run.triggerSource)}
            </span>
            <span className="flex items-center gap-1">
              <Clock className="size-3.5" /> {formatDuration(durationBetween(run.startedAt ?? run.createdAt, run.completedAt))}
            </span>
            <span className="flex items-center gap-1">
              <Rows3 className="size-3.5" /> {done}/{latest.filter((s) => s.status !== 'SKIPPED').length || visible.length} steps
            </span>
            {repairs > 0 && (
              <span className="flex items-center gap-1 text-ai">
                <Repeat2 className="size-3.5" /> {repairs} self-heal{repairs === 1 ? '' : 's'}
              </span>
            )}
            {run.usage.totalTokens > 0 && (
              <span className="flex items-center gap-1">
                <Coins className="size-3.5" /> {formatNumber(run.usage.totalTokens)} tokens · {run.usage.llmCalls} calls
              </span>
            )}
          </div>
        </div>
        <RunActions run={run} />
      </div>
    </div>
  );
}

function RunActions({ run }: { run: ExecutionDetail }) {
  const [confirm, setConfirm] = useState<null | 'cancel' | 'rollback'>(null);
  const inv = [qk.execution(run.id), ['executions', 'list']];
  const pause = useAction(() => api.post(`/workflow-executions/${run.id}/pause`), { success: 'Run paused', invalidate: inv });
  const resume = useAction(() => api.post(`/workflow-executions/${run.id}/resume`), { success: 'Run resumed', invalidate: inv });
  const cancel = useAction((rollback: boolean) => api.post(`/workflow-executions/${run.id}/cancel`, { rollback }), { success: 'Run cancelled', invalidate: inv, onSuccess: () => setConfirm(null) });
  const rollback = useAction(() => api.post(`/workflow-executions/${run.id}/rollback`), { success: 'Rollback started', invalidate: inv, onSuccess: () => setConfirm(null) });
  const active = ['RUNNING', 'WAITING_APPROVAL', 'PENDING'].includes(run.status);
  const compensable = run.definition.steps.some((s) => s.compensate) && ['COMPLETED', 'FAILED', 'CANCELLED'].includes(run.status);
  return (
    <div className="flex items-center gap-2">
      {active && (
        <Button icon={<Pause className="size-3.5" />} loading={pause.isPending} onClick={() => pause.mutate(undefined)}>
          Pause
        </Button>
      )}
      {run.status === 'PAUSED' && (
        <Button variant="primary" icon={<Play className="size-3.5" />} loading={resume.isPending} onClick={() => resume.mutate(undefined)}>
          Resume
        </Button>
      )}
      {(active || run.status === 'PAUSED') && (
        <Button variant="danger-ghost" icon={<Ban className="size-3.5" />} onClick={() => setConfirm('cancel')}>
          Cancel
        </Button>
      )}
      {compensable && (
        <Button icon={<Undo2 className="size-3.5" />} onClick={() => setConfirm('rollback')}>
          Roll back
        </Button>
      )}
      <Dialog
        open={confirm === 'cancel'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Cancel this run?"
        description="Running steps stop at their next checkpoint and pending approvals are withdrawn."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Keep running
            </Button>
            {run.definition.steps.some((s) => s.compensate) && (
              <Button loading={cancel.isPending && cancel.variables === true} onClick={() => cancel.mutate(true)}>
                Cancel & roll back
              </Button>
            )}
            <Button variant="danger" loading={cancel.isPending && cancel.variables === false} onClick={() => cancel.mutate(false)}>
              Cancel run
            </Button>
          </>
        }
      >
        <p className="text-[13px] text-fg-muted">“Cancel & roll back” also runs the compensation actions of completed steps in reverse order (for example reverting a deployment).</p>
      </Dialog>
      <Dialog
        open={confirm === 'rollback'}
        onOpenChange={(o) => !o && setConfirm(null)}
        title="Roll back this run?"
        description="Compensation actions of completed steps run in reverse order. Each is recorded in the audit log."
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirm(null)}>
              Not now
            </Button>
            <Button variant="danger" loading={rollback.isPending} onClick={() => rollback.mutate(undefined)}>
              Roll back
            </Button>
          </>
        }
      >
        <ul className="space-y-1 text-[12.5px]">
          {run.definition.steps
            .filter((s) => s.compensate)
            .map((s) => (
              <li key={s.key} className="flex items-center gap-2">
                <Undo2 className="size-3.5 text-warn" /> {s.name} → <Mono>{s.compensate!.tool}</Mono>
              </li>
            ))}
        </ul>
      </Dialog>
    </div>
  );
}

function FailureBanner({ run, onSelect }: { run: ExecutionDetail; onSelect: (k: string) => void }) {
  const failedKey = run.error?.steps?.[0];
  const step = failedKey ? latestSteps(run.steps).get(failedKey)?.run : undefined;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-lg border border-bad/35 bg-bad-soft px-4 py-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-bad" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-semibold text-bad">{run.error?.message}</div>
        {step?.error && <div className="mt-1 line-clamp-3 text-[12.5px] text-fg-muted">{step.error.message}</div>}
      </div>
      {failedKey && (
        <Button size="sm" onClick={() => onSelect(failedKey)}>
          Inspect step
        </Button>
      )}
    </div>
  );
}

function Timeline({ run, onSelect }: { run: ExecutionDetail; onSelect: (k: string) => void }) {
  // Executed steps in start order; queued-but-not-started steps keep definition order at the end.
  const executed = run.steps
    .filter((s) => s.status !== 'PENDING' || s.startedAt)
    .sort((a, b) => (a.startedAt ?? '\uffff').localeCompare(b.startedAt ?? '\uffff') || a.position - b.position);
  if (!executed.length) return <EmptyState compact icon={<Clock />} title="Waiting to start" description="Steps appear here as soon as they are scheduled." />;
  return (
    <Card>
      <ol className="divide-y divide-line">
        {executed.map((s) => {
          const a = agentOf(s);
          return (
            <li key={s.id}>
              <button type="button" onClick={() => onSelect(s.stepKey)} className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-sunken/60">
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md" style={{ background: `color-mix(in oklab, ${a.color} 14%, transparent)`, color: a.color }}>
                  <a.icon className="size-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium">{s.name}</span>
                    {s.iteration > 0 && (
                      <Badge tone="ai" icon={<Repeat2 className="size-3" />}>
                        iteration {s.iteration + 1}
                      </Badge>
                    )}
                    {s.attempt > 1 && <Badge tone="warn">attempt {s.attempt}</Badge>}
                  </div>
                  {s.summary && <p className="mt-0.5 text-[12.5px] text-fg-muted">{s.summary}</p>}
                  {s.error && s.status === 'FAILED' && <p className="mt-0.5 line-clamp-2 text-[12px] text-bad">{s.error.message}</p>}
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <StatusBadge status={s.status} />
                  <span className="font-mono text-[11px] text-fg-subtle">{s.durationMs ? formatDuration(s.durationMs) : isLive(s.status) ? formatDuration(durationBetween(s.startedAt, null)) : ''}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function Logs({ run }: { run: ExecutionDetail }) {
  const { data, isLoading } = useExecutionLogs(run.id);
  const [level, setLevel] = useState<'ALL' | 'WARN'>('ALL');
  const [step, setStep] = useState('');
  const byId = useMemo(() => new Map(run.steps.map((s) => [s.id, s])), [run.steps]);
  const rows = (data ?? []).filter((l) => (level === 'ALL' || l.level === 'WARN' || l.level === 'ERROR') && (!step || l.stepId === step));
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Segmented value={level} onChange={setLevel} options={[{ value: 'ALL', label: 'All' }, { value: 'WARN', label: 'Warnings & errors' }]} />
        <select value={step} onChange={(e) => setStep(e.target.value)} className="h-7 rounded-md border border-line bg-surface px-2 text-[12px]" aria-label="Filter by step">
          <option value="">All steps</option>
          {run.steps.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
              {s.iteration ? ` (iteration ${s.iteration + 1})` : ''}
            </option>
          ))}
        </select>
        {!TERMINAL_EXECUTION_STATUSES.includes(run.status) && (
          <span className="ml-auto flex items-center gap-1.5 text-[11.5px] text-ok">
            <span className="size-1.5 animate-pulse-dot rounded-full bg-ok" /> streaming
          </span>
        )}
      </div>
      <div className="max-h-[520px] overflow-y-auto bg-sunken/40 py-2 font-mono text-[11.5px] leading-[1.65]">
        {isLoading && <div className="px-4 text-fg-subtle">Loading logs…</div>}
        {!isLoading && !rows.length && <div className="px-4 py-6 text-center text-fg-subtle">No log lines yet.</div>}
        {rows.map((l) => (
          <div key={l.id} className="flex gap-3 px-4 hover:bg-sunken">
            <span className="shrink-0 text-fg-subtle">{new Date(l.createdAt).toLocaleTimeString(undefined, { hour12: false })}</span>
            <span className={cn('w-10 shrink-0', l.level === 'ERROR' ? 'text-bad' : l.level === 'WARN' ? 'text-warn' : l.level === 'DEBUG' ? 'text-fg-subtle' : 'text-arc')}>{l.level}</span>
            <span className="w-40 shrink-0 truncate text-fg-muted">{l.stepId ? (byId.get(l.stepId)?.name ?? '') : 'run'}</span>
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{l.message}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

function Outputs({ run, onArtifact }: { run: ExecutionDetail; onArtifact: (id: string) => void }) {
  const empty = !run.artifacts.length && !run.codeGenerations.length && !run.codeReviews.length && !run.qaRuns.length;
  if (empty) return <EmptyState compact icon={<FileText />} title="No outputs yet" description="Tickets, specs, plans, code, reviews, test reports and docs produced by this run appear here." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {run.artifacts.length > 0 && (
        <Card>
          <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Artifacts</div>
          <ul className="divide-y divide-line">
            {run.artifacts.map((a) => (
              <li key={a.id}>
                <button type="button" onClick={() => onArtifact(a.id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-sunken/60">
                  <FileText className="size-4 text-fg-subtle" />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{a.title}</span>
                  <Badge>{titleCase(a.type)}</Badge>
                  {a.version > 1 && <span className="font-mono text-[11px] text-fg-subtle">v{a.version}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {run.codeGenerations.map((cg) => (
        <Card key={cg.id}>
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <GitBranch className="size-4 text-fg-subtle" />
            <span className="flex-1 truncate font-mono text-[12.5px]">{cg.branch}</span>
            {cg.iterations > 0 && (
              <Badge tone="ai" icon={<Repeat2 className="size-3" />}>
                {cg.iterations} fix{cg.iterations === 1 ? '' : 'es'}
              </Badge>
            )}
            <StatusBadge status={cg.status} />
          </div>
          <div className="space-y-3 px-4 py-3">
            <ul className="space-y-1 font-mono text-[11.5px]">
              {cg.files.map((f) => (
                <li key={f.path} className="truncate">
                  <span className={f.action === 'create' ? 'text-ok' : f.action === 'delete' ? 'text-bad' : 'text-warn'}>{f.action}</span> {f.path}
                </li>
              ))}
            </ul>
            {cg.validation && (
              <div className="rounded-md border border-line">
                <div className={cn('border-b border-line px-3 py-1.5 text-[12px] font-medium', cg.validation.passed ? 'text-ok' : cg.validation.passed === false ? 'text-bad' : 'text-fg-muted')}>{cg.validation.summary}</div>
                <ul className="divide-y divide-line">
                  {cg.validation.checks.map((c) => (
                    <li key={c.name} className="flex items-center gap-2 px-3 py-1.5 text-[12px]">
                      <StatusDot status={c.status === 'passed' ? 'COMPLETED' : c.status === 'failed' ? 'FAILED' : 'SKIPPED'} />
                      <span className="w-20">{c.name}</span>
                      <Mono className="flex-1 truncate">{c.command || c.excerpt}</Mono>
                      <span className="font-mono text-[11px] text-fg-subtle">{c.durationMs ? formatDuration(c.durationMs) : ''}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap gap-3 text-[12px]">
              {cg.commitSha && <Mono>commit {shortSha(cg.commitSha)}</Mono>}
              {cg.prUrl && (
                <ExtLink href={cg.prUrl} className="inline-flex items-center gap-1">
                  PR #{cg.prNumber} <ExternalLink className="size-3" />
                </ExtLink>
              )}
              {cg.simulated && <span className="text-warn">simulated</span>}
            </div>
          </div>
        </Card>
      ))}
      {run.codeReviews.map((r) => (
        <Card key={r.id}>
          <Link to={`/code-reviews/${r.id}`} className="flex items-center gap-2 border-b border-line px-4 py-2.5 hover:bg-sunken/60">
            <span className="flex-1 text-[12.5px] font-semibold">AI code review</span>
            <RiskBadge level={r.riskLevel} />
            <Badge tone={r.verdict === 'APPROVE' ? 'ok' : r.verdict === 'REQUEST_CHANGES' ? 'bad' : 'neutral'}>{titleCase(r.verdict ?? 'pending')}</Badge>
            <ArrowUpRight className="size-3.5 text-fg-subtle" />
          </Link>
          <div className="px-4 py-3 text-[12.5px] text-fg-muted">
            {r.summary}
            <div className="mt-2 flex gap-3 font-mono text-[11.5px]">
              <span className={r.criticalCount ? 'text-bad' : ''}>{r.criticalCount} critical</span>
              <span className={r.highCount ? 'text-accent' : ''}>{r.highCount} high</span>
              <span>{r.mediumCount} medium</span>
              <span>{r.lowCount} low</span>
            </div>
          </div>
        </Card>
      ))}
      {run.qaRuns.map((q) => (
        <Card key={q.id} className="px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="flex-1 truncate text-[12.5px] font-semibold">{q.title}</span>
            <StatusBadge status={q.status} />
          </div>
          <div className="mt-2 flex items-center gap-3 font-mono text-[12px]">
            <span className="text-ok">{q.passed} passed</span>
            <span className={q.failed ? 'text-bad' : 'text-fg-subtle'}>{q.failed} failed</span>
            <span className="text-fg-subtle">{q.skipped} skipped</span>
            <span className="ml-auto text-fg-subtle">{titleCase(q.type)} · {formatDuration(q.durationMs)}</span>
          </div>
          {q.total > 0 && (
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-sunken">
              <span className="bg-ok" style={{ width: `${(q.passed / q.total) * 100}%` }} />
              <span className="bg-bad" style={{ width: `${(q.failed / q.total) * 100}%` }} />
            </div>
          )}
        </Card>
      ))}
    </div>
  );
}

function SideEffects({ run }: { run: ExecutionDetail }) {
  if (!run.externalResources.length && !run.deployments.length) return <EmptyState compact icon={<ExternalLink />} title="No external changes" description="Tickets, branches, pull requests, pages and deployments created by this run are listed here with links." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {run.externalResources.length > 0 && (
        <Card>
          <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Created in external systems</div>
          <ul className="divide-y divide-line">
            {run.externalResources.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
                <Badge className="w-24 justify-center">{providerName(r.provider)}</Badge>
                <span className="w-24 shrink-0 text-fg-subtle">{titleCase(r.type)}</span>
                <span className="min-w-0 flex-1 truncate">
                  <ExtLink href={r.simulated ? null : r.url}>{r.key ?? r.title ?? r.type}</ExtLink>
                  {r.title && r.key && <span className="text-fg-subtle"> · {r.title}</span>}
                </span>
                {r.simulated ? <Badge tone="warn">simulated</Badge> : r.url ? <ExternalLink className="size-3.5 text-fg-subtle" /> : null}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {run.deployments.map((d) => (
        <Card key={d.id}>
          <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
            <span className="flex-1 text-[12.5px] font-semibold">Deploy → {d.environment.name}</span>
            {d.simulated && <Badge tone="warn">simulated</Badge>}
            <StatusBadge status={d.status} />
          </div>
          <div className="space-y-2 px-4 py-3 text-[12px]">
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-fg-muted">
              <Mono>{d.version}</Mono>
              {d.commitSha && <Mono>{shortSha(d.commitSha)}</Mono>}
              <span>{formatDateTime(d.startedAt ?? d.createdAt)}</span>
              {d.externalUrl && <ExtLink href={d.externalUrl}>provider ↗</ExtLink>}
            </div>
            {[...d.healthChecks, ...d.smokeTests].map((p) => (
              <div key={p.name} className="flex items-center gap-2">
                <StatusDot status={p.status === 'passed' ? 'COMPLETED' : 'FAILED'} />
                <span className="w-32 truncate">{p.name}</span>
                <span className="flex-1 truncate text-fg-subtle">{p.detail}</span>
                <span className="font-mono text-[11px] text-fg-subtle">{p.httpStatus ?? '—'} · {p.latencyMs ?? '—'}ms</span>
              </div>
            ))}
            {d.error?.message && <div className="text-bad">{d.error.message}</div>}
          </div>
        </Card>
      ))}
    </div>
  );
}

function ApprovalList({ run, onOpen }: { run: ExecutionDetail; onOpen: (id: string) => void }) {
  if (!run.approvals.length) return <EmptyState compact icon={<Hand />} title="No approvals in this run" description="Gated actions such as production deploys and merges pause here for a human decision." />;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {run.approvals.map((a) => (
          <li key={a.id}>
            <button type="button" onClick={() => onOpen(a.id)} className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-sunken/60">
              <Hand className={cn('size-4', a.status === 'PENDING' ? 'text-accent' : 'text-fg-subtle')} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-medium">{a.title}</span>
                <span className="block text-[11.5px] text-fg-subtle">
                  <span className="font-mono">{a.action}</span>
                  {a.decidedBy && ` · ${titleCase(a.status)} by ${a.decidedBy.name} ${timeAgo(a.decidedAt)}`}
                </span>
              </span>
              <RiskBadge level={a.riskLevel} />
              <StatusBadge status={a.status} />
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function AgentsAndTools({ run }: { run: ExecutionDetail }) {
  const stepName = new Map(run.steps.map((s) => [s.id, s.name]));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">
          <Bot className="size-4 text-fg-subtle" /> Agent runs
        </div>
        {!run.agentRuns.length ? (
          <div className="px-4 py-6 text-center text-[12px] text-fg-subtle">No LLM calls in this run.</div>
        ) : (
          <ul className="divide-y divide-line">
            {run.agentRuns.map((r) => {
              const a = agentOf({ agent: r.agent.key });
              return (
                <li key={r.id} className="flex items-start gap-2.5 px-4 py-2.5 text-[12.5px]">
                  <a.icon className="mt-0.5 size-3.5 shrink-0" style={{ color: a.color }} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate">
                      <span className="font-medium">{r.agent.name}</span> <span className="text-fg-muted">· {r.summary ?? r.task}</span>
                    </div>
                    <div className="mt-0.5 font-mono text-[11px] text-fg-subtle">
                      {r.model ?? '—'} · {formatNumber(r.totalTokens)} tok · {r.llmCalls} call{r.llmCalls === 1 ? '' : 's'} · {formatDuration(r.durationMs)}
                    </div>
                  </div>
                  <StatusDot status={r.status} />
                </li>
              );
            })}
          </ul>
        )}
      </Card>
      <Card>
        <div className="border-b border-line px-4 py-2.5 text-[12.5px] font-semibold">Tool executions (idempotency ledger)</div>
        <ul className="max-h-[480px] divide-y divide-line overflow-y-auto">
          {run.toolExecutions.map((t) => (
            <li key={t.id} className="flex items-center gap-2.5 px-4 py-2 text-[12px]">
              <StatusDot status={t.status} />
              <Mono className="w-44 truncate text-fg">{t.tool}</Mono>
              <span className="min-w-0 flex-1 truncate text-fg-subtle">{t.stepId ? stepName.get(t.stepId) : ''}</span>
              {t.attempt > 1 && <Badge tone="warn">#{t.attempt}</Badge>}
              {t.simulated && <Badge tone="warn">sim</Badge>}
              <span className="w-14 text-right font-mono text-[11px] text-fg-subtle">{formatDuration(t.durationMs)}</span>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function RunAudit({ executionId }: { executionId: string }) {
  const { data, isLoading } = useAudit({ executionId, pageSize: 100 });
  return (
    <Card>
      {isLoading && <div className="p-4 text-[12px] text-fg-subtle">Loading…</div>}
      <ul className="divide-y divide-line">
        {data?.items.map((e) => (
          <li key={e.id} className="flex items-center gap-3 px-4 py-2 text-[12px]">
            <span className="w-36 shrink-0 font-mono text-[11px] text-fg-subtle">{formatDateTime(e.createdAt)}</span>
            <StatusDot status={e.status === 'SUCCESS' ? 'COMPLETED' : e.status === 'DENIED' ? 'WAITING_APPROVAL' : 'FAILED'} title={e.status} />
            <Mono className="w-52 truncate text-fg">{e.action}</Mono>
            <span className="min-w-0 flex-1 truncate text-fg-muted">{e.actor?.name ?? e.actorLabel ?? titleCase(e.actorType)}</span>
            {e.status !== 'SUCCESS' && <Badge tone={e.status === 'DENIED' ? 'accent' : 'bad'}>{e.status.toLowerCase()}</Badge>}
          </li>
        ))}
      </ul>
      {data && data.total > data.items.length && (
        <div className="border-t border-line px-4 py-2 text-[12px] text-fg-subtle">
          Showing {data.items.length} of {data.total}.{' '}
          <Link to={`/audit-logs?executionId=${executionId}`} className="text-accent hover:underline">
            Open in audit log
          </Link>
        </div>
      )}
    </Card>
  );
}

function StepSheet({ run, step, open, onClose, onApproval }: { run: ExecutionDetail; step: ExecutionStep | null; open: boolean; onClose: () => void; onApproval: (id: string) => void }) {
  const retry = useAction((s: ExecutionStep) => api.post(`/workflow-executions/${run.id}/steps/${s.id}/retry`), { success: 'Step queued for retry', invalidate: [qk.execution(run.id)], onSuccess: onClose });
  const history = step ? run.steps.filter((s) => s.stepKey === step.stepKey).sort((a, b) => a.iteration - b.iteration) : [];
  const def = step ? run.definition.steps.find((s) => s.key === step.stepKey) : undefined;
  const approval = step ? run.approvals.find((a) => a.executionStepId === step.id) : undefined;
  const logs = useExecutionLogs(run.id);
  const stepLogs = (logs.data ?? []).filter((l) => history.some((h) => h.id === l.stepId));
  const a = step ? agentOf(step) : null;
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => !o && onClose()}
      width={620}
      title={step?.name ?? ''}
      subtitle={
        step && a ? (
          <span className="flex items-center gap-2">
            <span style={{ color: a.color }}>{a.label} agent</span> · <Mono>{step.tool ?? step.type}</Mono>
          </span>
        ) : null
      }
      actions={
        step?.status === 'FAILED' && ['FAILED', 'RUNNING', 'WAITING_APPROVAL', 'CANCELLED'].includes(run.status) ? (
          <Tooltip content="Re-run this step and the steps skipped because of it">
            <Button size="sm" icon={<RotateCcw className="size-3.5" />} loading={retry.isPending} onClick={() => retry.mutate(step)}>
              Retry step
            </Button>
          </Tooltip>
        ) : null
      }
    >
      {step && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={step.status} />
            {step.attempt > 0 && <Badge>attempt {step.attempt}/{step.maxAttempts}</Badge>}
            {step.iteration > 0 && <Badge tone="ai">iteration {step.iteration + 1}</Badge>}
            <span className="ml-auto font-mono text-[11.5px] text-fg-subtle">{formatDuration(step.durationMs ?? durationBetween(step.startedAt, step.completedAt))}</span>
          </div>
          {step.summary && <p className="text-[13px]">{step.summary}</p>}
          {step.error && (
            <div className="rounded-md border border-bad/30 bg-bad-soft px-3 py-2.5 text-[12.5px] text-bad">
              <div className="font-medium">{step.error.kind ? `${titleCase(step.error.kind)} error` : 'Error'}</div>
              <div className="mt-1 whitespace-pre-wrap text-bad/90">{step.error.message}</div>
            </div>
          )}
          {approval && (
            <button type="button" onClick={() => onApproval(approval.id)} className="flex w-full items-center gap-2 rounded-md border border-accent/30 bg-accent-soft px-3 py-2 text-left text-[12.5px]">
              <Hand className="size-4 text-accent" />
              <span className="flex-1">
                Gate: {approval.title} · <span className="font-medium">{titleCase(approval.status)}</span>
                {approval.decidedBy && ` by ${approval.decidedBy.name}`}
              </span>
              <ArrowUpRight className="size-3.5" />
            </button>
          )}
          {history.length > 1 && (
            <section>
              <h4 className="label-caps mb-2">Self-healing history</h4>
              <ol className="space-y-1.5">
                {history.map((h) => (
                  <li key={h.id} className="flex items-center gap-2 text-[12.5px]">
                    <StatusDot status={h.status} />
                    <span className="w-24">Iteration {h.iteration + 1}</span>
                    <span className="min-w-0 flex-1 truncate text-fg-muted">{h.summary ?? h.error?.message}</span>
                  </li>
                ))}
              </ol>
            </section>
          )}
          {def && (def.when || def.successCondition || def.repair || def.runIf !== 'all_success') && (
            <section className="space-y-1 text-[12px]">
              <h4 className="label-caps mb-2">Behaviour</h4>
              {def.when && (
                <div>
                  <span className="text-fg-subtle">Runs when</span> <Mono className="text-fg">{def.when}</Mono>
                </div>
              )}
              {def.successCondition && (
                <div>
                  <span className="text-fg-subtle">Succeeds when</span> <Mono className="text-fg">{def.successCondition}</Mono>
                </div>
              )}
              {def.repair && (
                <div>
                  <span className="text-fg-subtle">On failure, repair with</span> <Mono className="text-fg">{def.repair.step}</Mono> <span className="text-fg-subtle">up to {def.repair.maxIterations}×</span>
                </div>
              )}
              {def.runIf !== 'all_success' && (
                <div>
                  <span className="text-fg-subtle">Run policy</span> <Mono className="text-fg">{def.runIf}</Mono>
                </div>
              )}
            </section>
          )}
          <Disclosure title="Input" defaultOpen={!step.output}>
            <JsonView value={step.input ?? {}} />
          </Disclosure>
          {step.output && (
            <Disclosure title="Output" defaultOpen>
              <JsonView value={step.output} maxHeight={420} />
            </Disclosure>
          )}
          {stepLogs.length > 0 && (
            <Disclosure title={`Logs (${stepLogs.length})`}>
              <div className="max-h-64 overflow-y-auto rounded-md border border-line bg-sunken p-2 font-mono text-[11px] leading-5">
                {stepLogs.map((l) => (
                  <div key={l.id} className={l.level === 'ERROR' ? 'text-bad' : l.level === 'WARN' ? 'text-warn' : ''}>
                    {new Date(l.createdAt).toLocaleTimeString(undefined, { hour12: false })} {l.message}
                  </div>
                ))}
              </div>
            </Disclosure>
          )}
        </div>
      )}
    </Sheet>
  );
}

function ArtifactDialog({ artifactId, onClose }: { artifactId: string | null; onClose: () => void }) {
  const { data, isLoading } = useQuery({ queryKey: ['artifacts', artifactId], queryFn: () => api.get<Artifact>(`/artifacts/${artifactId}`), enabled: Boolean(artifactId) });
  const content = data?.content ?? '';
  const isDiff = data?.contentType === 'text/x-diff' || /^diff --git/m.test(content);
  const isJson = data?.contentType === 'application/json';
  return (
    <Dialog open={Boolean(artifactId)} onOpenChange={(o) => !o && onClose()} title={data?.title ?? 'Artifact'} description={data ? `${titleCase(data.type)} · v${data.version}` : undefined} wide>
      {isLoading || !data ? (
        <Skeleton className="h-48" />
      ) : isDiff ? (
        <DiffView diff={content} className="max-h-[60vh]" />
      ) : isJson ? (
        <JsonView value={safeParse(content)} maxHeight={560} />
      ) : (
        <MarkdownView>{content}</MarkdownView>
      )}
    </Dialog>
  );
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

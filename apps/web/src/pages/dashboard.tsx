import { useState } from 'react';
import { Link } from 'react-router';
import {
  Activity,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Coins,
  FileText,
  GitPullRequestArrow,
  Hand,
  Plug,
  Rocket,
  ShieldAlert,
  Sparkles,
  TriangleAlert,
  Workflow,
  Zap,
} from 'lucide-react';
import { useDashboard } from '@/api/queries';
import type { DashboardData } from '@/api/types';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { formatDuration, formatNumber, formatPercent, timeAgo, titleCase, durationBetween } from '@/lib/format';
import { ui } from '@/lib/ui-store';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, Stat } from '@/components/ui/page';
import { ForgeProgress, ModeBadge, RiskBadge, StatusBadge, StatusDot } from '@/components/ui/status';
import { commandLauncher } from '@/features/run-command';
import { agentOf } from '@/features/flow-graph';

const QUICK = [
  { id: 'feature.deliver', label: 'Deliver a feature', icon: Rocket },
  { id: 'pr.review', label: 'Review a PR', icon: GitPullRequestArrow },
  { id: 'deploy.environment', label: 'Deploy', icon: Zap },
  { id: 'docs.generate', label: 'Write docs', icon: FileText },
];

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function DashboardPage() {
  useDocumentTitle('Command Center');
  usePageContext({ title: 'Command Center' });
  const { user, organization } = useAuth();
  const { data, isLoading, error, refetch } = useDashboard();

  return (
    <Page wide>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="label-caps mb-1.5">Command Center · {organization?.organizationName}</div>
          <h1 className="text-[24px] leading-tight font-semibold tracking-[-0.025em]">
            {greeting()}, {user?.name.split(' ')[0]}.
          </h1>
        </div>
        <div className="flex gap-2">
          <Link to="/workflows/new">
            <Button icon={<Workflow className="size-3.5" />}>New flow</Button>
          </Link>
          <Button variant="primary" icon={<Zap className="size-3.5" />} onClick={() => ui.set({ paletteOpen: true })}>
            Run a command
          </Button>
        </div>
      </div>

      <AskForge />

      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <>
          <Headline data={data} loading={isLoading} />
          <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
            <div className="min-w-0 space-y-6">
              <LiveRuns data={data} loading={isLoading} />
              <RecentRuns data={data} loading={isLoading} />
              <Environments data={data} />
            </div>
            <div className="min-w-0 space-y-6">
              <NeedsYou data={data} />
              <AgentFeed data={data} />
              <Quality data={data} />
              <IntegrationHealth data={data} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}

function AskForge() {
  const [text, setText] = useState('');
  const submit = () => {
    if (text.trim().length < 2) return;
    ui.ask(text.trim());
    setText('');
  };
  return (
    <div className="relative mb-6 overflow-hidden rounded-xl border border-line bg-surface p-1 shadow-card">
      <div className="pointer-events-none absolute -top-24 right-10 h-48 w-96 rounded-full bg-accent/10 blur-3xl" />
      <form
        className="relative flex items-center gap-3 px-3 py-2"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-ai-soft text-ai">
          <Sparkles className="size-4" />
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Ask Forge"
          placeholder="Describe what you want shipped — “Implement a password reset feature for my authentication service”"
          className="h-10 min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg-subtle"
        />
        <Button
          type="submit"
          variant="primary"
          size="icon"
          aria-label="Ask Forge"
          disabled={text.trim().length < 2}
          icon={<ArrowUp className="size-4" />}
        />
      </form>
      <div className="relative flex flex-wrap gap-1.5 border-t border-line px-3 py-2">
        {QUICK.map((q) => (
          <button
            key={q.id}
            type="button"
            onClick={() => commandLauncher.open(q.id)}
            className="inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12px] text-fg-muted transition-colors hover:bg-sunken hover:text-fg"
          >
            <q.icon className="size-3.5 text-fg-subtle" />
            {q.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function Headline({ data, loading }: { data?: DashboardData; loading: boolean }) {
  const h = data?.headline;
  const v = (x: React.ReactNode) => (loading ? <Skeleton className="h-6 w-14" /> : x);
  return (
    <Card className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-x [&>*]:border-line max-lg:[&>*]:border-b">
      <Stat icon={<Activity />} label="Active runs" value={v(h?.activeRuns ?? 0)} tone={h?.activeRuns ? 'arc' : undefined} />
      <Stat
        icon={<Hand />}
        label="Awaiting approval"
        value={v(h?.pendingApprovals ?? 0)}
        tone={h?.pendingApprovals ? 'accent' : undefined}
      />
      <Stat icon={<CheckCircle2 />} label="Success rate · 30d" value={v(formatPercent(h?.successRate30d))} />
      <Stat icon={<Rocket />} label="Deployments · 7d" value={v(h?.deployments7d ?? 0)} />
      <Stat icon={<TriangleAlert />} label="Failed runs · 7d" value={v(h?.failedRuns7d ?? 0)} tone={h?.failedRuns7d ? 'bad' : undefined} />
      <Stat icon={<Coins />} label="LLM tokens · 7d" value={v(formatNumber(h?.tokens7d ?? 0))} />
    </Card>
  );
}

function LiveRuns({ data, loading }: { data?: DashboardData; loading: boolean }) {
  const runs = data?.activeRuns ?? [];
  return (
    <Card>
      <CardHeader
        icon={<Activity className="size-4" />}
        title="Live runs"
        description="Flows in progress across your projects"
        actions={
          <Link to="/executions" className="text-[12px] text-fg-muted hover:text-fg">
            All runs →
          </Link>
        }
      />
      {loading ? (
        <div className="space-y-3 px-4 pb-4">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : !runs.length ? (
        <EmptyState
          compact
          icon={<Zap />}
          title="Nothing running right now"
          description="Ask Forge for a feature, or run a command — progress streams here live."
          action={
            <Button size="sm" variant="primary" onClick={() => commandLauncher.open('feature.deliver')}>
              Deliver a feature
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {runs.map((r) => {
            const current = r.steps.find((s) => ['RUNNING', 'WAITING_APPROVAL', 'RETRYING', 'REPAIRING'].includes(s.status));
            const done = r.steps.filter((s) => s.status === 'COMPLETED').length;
            const a = current ? agentOf({ agent: current.agent }) : null;
            return (
              <li key={r.id}>
                <Link to={`/executions/${r.id}`} className="block px-4 py-3 transition-colors hover:bg-sunken/60">
                  <div className="flex items-center gap-2">
                    <StatusDot status={r.status} />
                    <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.title}</span>
                    <ModeBadge mode={r.mode} />
                    <StatusBadge status={r.status} />
                  </div>
                  <ForgeProgress steps={r.steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status }))} className="mt-2.5" />
                  <div className="mt-2 flex items-center gap-2 text-[11.5px] text-fg-subtle">
                    {a && current && (
                      <span className="flex min-w-0 items-center gap-1.5" style={{ color: a.color }}>
                        <a.icon className="size-3" />
                        <span className="truncate text-fg-muted">{current.name}</span>
                      </span>
                    )}
                    <span className="ml-auto shrink-0 font-mono">
                      {done}/{r.steps.filter((s) => s.status !== 'SKIPPED').length} · {formatDuration(durationBetween(r.startedAt, null))}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function RecentRuns({ data, loading }: { data?: DashboardData; loading: boolean }) {
  const runs = data?.recentRuns ?? [];
  if (!loading && !runs.length) return null;
  return (
    <Card>
      <CardHeader title="Recent runs" icon={<Zap className="size-4" />} />
      <ul className="divide-y divide-line border-t border-line">
        {runs.slice(0, 8).map((r) => (
          <li key={r.id}>
            <Link to={`/executions/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-sunken/60">
              <StatusDot status={r.status} />
              <span className="min-w-0 flex-1 truncate">{r.title}</span>
              {r.project && <span className="hidden font-mono text-[11px] text-fg-subtle sm:inline">{r.project.key}</span>}
              <ModeBadge mode={r.mode} />
              <span className="w-24 shrink-0 text-right text-[11.5px] text-fg-subtle">{timeAgo(r.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Environments({ data }: { data?: DashboardData }) {
  const latest = new Map<string, NonNullable<DashboardData['deployments']>[number]>();
  for (const d of data?.deployments ?? []) {
    const key = `${d.project.key}:${d.environment.name}`;
    if (!latest.has(key)) latest.set(key, d);
  }
  const items = [...latest.values()];
  return (
    <Card>
      <CardHeader
        icon={<Rocket className="size-4" />}
        title="Environments"
        description="Latest deployment per environment"
        actions={
          <Link to="/deployments" className="text-[12px] text-fg-muted hover:text-fg">
            Deployments →
          </Link>
        }
      />
      {!items.length ? (
        <EmptyState
          compact
          icon={<Rocket />}
          title="No deployments yet"
          description="Deployments started by flows appear here with health checks and smoke tests."
        />
      ) : (
        <div className="grid gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {items.map((d) => (
            <div key={d.id} className="bg-surface px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[12.5px] font-medium">
                  {d.project.key} · {d.environment.name}
                </span>
                <StatusDot status={d.status} />
              </div>
              <div className="mt-1 truncate font-mono text-[11.5px] text-fg-muted">{d.version}</div>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-fg-subtle">
                {timeAgo(d.completedAt ?? d.createdAt)}
                {d.simulated && <span className="text-warn">· simulated</span>}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function NeedsYou({ data }: { data?: DashboardData }) {
  const approvals = data?.pendingApprovals ?? [];
  const failed = data?.failedRuns ?? [];
  return (
    <Card className={cn(approvals.length && 'border-accent/30')}>
      <CardHeader
        icon={<Hand className="size-4" />}
        title="Needs you"
        description={approvals.length || failed.length ? 'Decisions and failures waiting for a human' : undefined}
      />
      {!approvals.length && !failed.length ? (
        <EmptyState compact icon={<CheckCircle2 />} title="All clear" description="No pending approvals or recent failures." />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {approvals.map((a) => (
            <li key={a.id}>
              <Link to={`/approvals/${a.id}`} className="block px-4 py-3 hover:bg-sunken/60">
                <div className="flex items-center gap-2">
                  <Hand className="size-3.5 shrink-0 text-accent" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.title}</span>
                  <RiskBadge level={a.riskLevel} />
                </div>
                <div className="mt-1 truncate pl-5.5 text-[11.5px] text-fg-subtle">
                  {a.execution?.title} · {timeAgo(a.createdAt)}
                </div>
              </Link>
            </li>
          ))}
          {failed.map((f) => (
            <li key={f.id}>
              <Link to={`/executions/${f.id}`} className="block px-4 py-3 hover:bg-sunken/60">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="size-3.5 shrink-0 text-bad" />
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{f.title}</span>
                </div>
                <div className="mt-1 line-clamp-2 pl-5.5 text-[11.5px] text-bad/80">{f.error?.message ?? 'Failed'}</div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function AgentFeed({ data }: { data?: DashboardData }) {
  const items = data?.agentActivity ?? [];
  return (
    <Card>
      <CardHeader
        icon={<Sparkles className="size-4" />}
        title="Agent activity"
        actions={
          <Link to="/agents" className="text-[12px] text-fg-muted hover:text-fg">
            Agents →
          </Link>
        }
      />
      {!items.length ? (
        <EmptyState
          compact
          icon={<Sparkles />}
          title="Agents are idle"
          description="Planning, code, review, QA, release and docs agents report what they do here."
        />
      ) : (
        <ol className="relative space-y-3 border-t border-line px-4 py-3">
          {items.slice(0, 8).map((r) => {
            const a = agentOf({ agent: r.agent.key });
            return (
              <li key={r.id} className="flex gap-2.5">
                <span
                  className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-md"
                  style={{ background: `color-mix(in oklab, ${a.color} 15%, transparent)`, color: a.color }}
                >
                  <a.icon className="size-3" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px]">
                    <span className="font-medium">{r.agent.name}</span> <span className="text-fg-muted">· {r.summary ?? r.task}</span>
                  </div>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-subtle">
                    <StatusDot status={r.status} className="size-1.5" />
                    {timeAgo(r.startedAt)}
                    {r.totalTokens > 0 && <span className="font-mono">· {formatNumber(r.totalTokens)} tok</span>}
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

function Quality({ data }: { data?: DashboardData }) {
  if (!data) return null;
  const { qa, reviews } = data;
  return (
    <Card>
      <CardHeader icon={<CheckCircle2 className="size-4" />} title="Quality · 30 days" />
      <div className="grid grid-cols-2 divide-x divide-line border-t border-line">
        <Link to="/qa" className="px-4 py-3 hover:bg-sunken/60">
          <div className="text-[11.5px] text-fg-muted">Tests</div>
          <div className="mt-1 font-mono text-[18px]">
            <span className="text-ok">{formatNumber(qa.passed)}</span>
            <span className="text-fg-subtle"> / </span>
            <span className={qa.failed ? 'text-bad' : 'text-fg-subtle'}>{formatNumber(qa.failed)}</span>
          </div>
          <div className="text-[11px] text-fg-subtle">passed / failed · {qa.runs} runs</div>
        </Link>
        <Link to="/code-reviews" className="px-4 py-3 hover:bg-sunken/60">
          <div className="text-[11.5px] text-fg-muted">Review findings</div>
          <div className="mt-1 flex items-baseline gap-2 font-mono text-[18px]">
            <span className={reviews.critical ? 'text-bad' : 'text-fg-subtle'}>{reviews.critical}</span>
            <span className={reviews.high ? 'text-accent' : 'text-fg-subtle'}>{reviews.high}</span>
            <span className="text-warn">{reviews.medium}</span>
          </div>
          <div className="text-[11px] text-fg-subtle">critical · high · medium</div>
        </Link>
      </div>
    </Card>
  );
}

function IntegrationHealth({ data }: { data?: DashboardData }) {
  const items = data?.integrations ?? [];
  return (
    <Card>
      <CardHeader
        icon={<Plug className="size-4" />}
        title="Integrations"
        actions={
          <Link to="/integrations" className="text-[12px] text-fg-muted hover:text-fg">
            Manage →
          </Link>
        }
      />
      {!items.length ? (
        <EmptyState
          compact
          icon={<Plug />}
          title="Connect your tools"
          description="GitHub, Jira or Trello, Notion and your CI/CD — Vanshil’s SDLC acts through them on your behalf."
          action={
            <Link to="/integrations">
              <Button size="sm" variant="primary" icon={<ArrowRight className="size-3.5" />}>
                Connect
              </Button>
            </Link>
          }
        />
      ) : (
        <ul className="divide-y divide-line border-t border-line">
          {items.map((i) => (
            <li key={i.id} className="flex items-center gap-2.5 px-4 py-2.5 text-[12.5px]">
              <StatusDot status={i.status === 'CONNECTED' ? i.healthStatus : i.status} />
              <span className="flex-1 truncate">{i.name}</span>
              <span className="text-[11px] text-fg-subtle">{titleCase(i.healthStatus)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

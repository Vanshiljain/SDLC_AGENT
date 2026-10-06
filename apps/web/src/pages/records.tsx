import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckCheck, ExternalLink, FileText, GitPullRequestArrow, ListChecks, Pencil, Plus, Save } from 'lucide-react';
import { BRAND, DOCUMENT_TYPES, TASK_PRIORITIES, TASK_STATUSES } from '@forgeline/shared';
import { api } from '@/api/client';
import { qk, useAction, useDocument, useDocuments, useProjects, useQaRuns, useReview, useReviews, useTasks } from '@/api/queries';
import type { QaRun, ReviewFinding, Task } from '@/api/types';
import { cn } from '@/lib/cn';
import { formatDuration, timeAgo, titleCase, providerName } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Dialog, Sheet } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, Mono, Skeleton, type Tone } from '@/components/ui/primitives';
import { MarkdownView } from '@/components/ui/content';
import { EmptyState, ErrorState, Page, PageHeader } from '@/components/ui/page';
import { ModeBadge, RiskBadge, StatusBadge } from '@/components/ui/status';
import { Pagination, Table, TableSkeleton, Td, Th, Tr } from '@/components/ui/table';
import { commandLauncher } from '@/features/run-command';

function ProjectFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const projects = useProjects();
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} className="h-7 w-48 text-[12px]" aria-label="Project">
      <option value="">All projects</option>
      {projects.data?.map((p) => (
        <option key={p.id} value={p.id}>
          {p.name}
        </option>
      ))}
    </Select>
  );
}

// ─────────────────────────── Tasks ───────────────────────────
const PRIORITY_TONE: Record<string, Tone> = { HIGHEST: 'bad', HIGH: 'accent', MEDIUM: 'warn', LOW: 'neutral', LOWEST: 'neutral' };

export function TasksPage() {
  useDocumentTitle('Tasks');
  usePageContext({ title: 'Tasks' });
  const { can } = useAuth();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useTasks({ projectId: projectId || undefined, status: status || undefined, page, pageSize: 30 });
  const [editing, setEditing] = useState<Task | 'new' | null>(null);
  const update = useAction((v: { id: string; status: string }) => api.patch(`/tasks/${v.id}`, { status: v.status }), {
    invalidate: [['tasks']],
  });
  return (
    <Page wide>
      <PageHeader
        title="Tasks"
        description="Work items created by flows and people. When Jira or Trello is connected, tickets live there and are mirrored here; otherwise Vanshil’s SDLC tracks them natively."
        actions={
          <>
            <ProjectFilter value={projectId} onChange={(v) => (setProjectId(v), setPage(1))} />
            <Select
              value={status}
              onChange={(e) => (setStatus(e.target.value), setPage(1))}
              className="h-7 w-36 text-[12px]"
              aria-label="Status"
            >
              <option value="">All statuses</option>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
            {can('ticket:write') && (
              <Button size="sm" variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setEditing('new')}>
                New task
              </Button>
            )}
          </>
        }
      />
      {error ? (
        <ErrorState error={error} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Task</Th>
                <Th className="hidden md:table-cell">Project</Th>
                <Th>Priority</Th>
                <Th>Status</Th>
                <Th className="text-right">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton cols={5} />}
              {data?.items.map((t) => (
                <Tr key={t.id} onClick={() => setEditing(t)}>
                  <Td>
                    <div className="flex items-center gap-2">
                      {t.externalKey && <Mono className="text-fg">{t.externalKey}</Mono>}
                      <span className="max-w-[460px] truncate font-medium">{t.title}</span>
                      {t.externalUrl && (
                        <a
                          href={t.externalUrl}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="text-fg-subtle hover:text-fg"
                          aria-label="Open in provider"
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      )}
                    </div>
                    <div className="text-[11.5px] text-fg-subtle">{t.externalProvider ? providerName(t.externalProvider) : BRAND.name}</div>
                  </Td>
                  <Td className="hidden text-fg-muted md:table-cell">{t.project?.name ?? '—'}</Td>
                  <Td>
                    <Badge tone={PRIORITY_TONE[t.priority] ?? 'neutral'}>{titleCase(t.priority)}</Badge>
                  </Td>
                  <Td>
                    <select
                      value={t.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => update.mutate({ id: t.id, status: e.target.value })}
                      disabled={!can('ticket:write')}
                      className="h-7 rounded-md border border-line bg-surface px-2 text-[12px]"
                      aria-label="Status"
                    >
                      {TASK_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {titleCase(s)}
                        </option>
                      ))}
                    </select>
                  </Td>
                  <Td className="text-right text-[12px] text-fg-muted">{timeAgo(t.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {data && !data.items.length && (
            <EmptyState compact icon={<ListChecks />} title="No tasks" description="Tickets created by delivery flows appear here." />
          )}
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </Card>
      )}
      {editing && <TaskDialog task={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
    </Page>
  );
}

function TaskDialog({ task, onClose }: { task: Task | null; onClose: () => void }) {
  const projects = useProjects();
  const [form, setForm] = useState({
    title: task?.title ?? '',
    description: task?.description ?? '',
    priority: task?.priority ?? 'MEDIUM',
    status: task?.status ?? 'TODO',
    projectId: task?.projectId ?? '',
  });
  useEffect(() => {
    if (!form.projectId && projects.data?.length === 1) setForm((f) => ({ ...f, projectId: projects.data![0]!.id }));
  }, [projects.data, form.projectId]);
  const save = useAction(() => (task ? api.patch(`/tasks/${task.id}`, form) : api.post('/tasks', form)), {
    success: task ? 'Task updated' : 'Task created',
    invalidate: [['tasks']],
    onSuccess: onClose,
  });
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title={task ? 'Edit task' : 'New task'}
      description={
        task?.externalProvider
          ? `Mirrors ${providerName(task.externalProvider)} ${task.externalKey ?? ''}. Edit details in ${providerName(task.externalProvider)}; status changes here are local.`
          : undefined
      }
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            disabled={!form.title.trim() || !form.projectId}
            onClick={() => save.mutate(undefined)}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Title" required>
          <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Project" required>
            <Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">Select…</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Priority">
            <Select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {titleCase(p)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Status">
            <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {TASK_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Description (Markdown)">
          <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={8} />
        </Field>
      </div>
    </Dialog>
  );
}

// ─────────────────────────── Code reviews ───────────────────────────
export function CodeReviewsPage() {
  useDocumentTitle('Code reviews');
  usePageContext({ title: 'Code reviews' });
  const navigate = useNavigate();
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const { data, isLoading, error } = useReviews({ projectId: projectId || undefined, page, pageSize: 25 });
  return (
    <Page wide>
      <PageHeader
        title="Code reviews"
        description="AI reviews of pull requests across correctness, security, performance, architecture and tests. Findings are posted to the PR when GitHub is connected."
        actions={
          <>
            <ProjectFilter value={projectId} onChange={(v) => (setProjectId(v), setPage(1))} />
            <Button
              size="sm"
              variant="primary"
              icon={<GitPullRequestArrow className="size-3.5" />}
              onClick={() => commandLauncher.open('pr.review')}
            >
              Review a PR
            </Button>
          </>
        }
      />
      {error ? (
        <ErrorState error={error} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Pull request</Th>
                <Th>Verdict</Th>
                <Th>Risk</Th>
                <Th className="hidden md:table-cell">Findings</Th>
                <Th className="text-right">When</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton cols={5} />}
              {data?.items.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/code-reviews/${r.id}`)}>
                  <Td>
                    <div className="max-w-[420px] truncate font-medium">{r.title}</div>
                    <div className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                      {r.project.name} {r.prNumber && `· #${r.prNumber}`} {r.postedToProvider && <Badge tone="ok">posted</Badge>}{' '}
                      {r.simulated && <Badge tone="warn">simulated</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <VerdictBadge verdict={r.verdict} />
                  </Td>
                  <Td>
                    <RiskBadge level={r.riskLevel} />
                  </Td>
                  <Td className="hidden font-mono text-[12px] md:table-cell">
                    <span className={r.criticalCount ? 'text-bad' : 'text-fg-subtle'}>{r.criticalCount}C</span>{' '}
                    <span className={r.highCount ? 'text-accent' : 'text-fg-subtle'}>{r.highCount}H</span>{' '}
                    <span className="text-warn">{r.mediumCount}M</span> <span className="text-fg-subtle">{r.lowCount}L</span>
                  </Td>
                  <Td className="text-right text-[12px] text-fg-muted">{timeAgo(r.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {data && !data.items.length && (
            <EmptyState
              compact
              icon={<GitPullRequestArrow />}
              title="No reviews yet"
              description="Run “Review a PR”, or comment “/forgeline review” on a pull request when webhooks are enabled."
            />
          )}
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </Card>
      )}
    </Page>
  );
}

function VerdictBadge({ verdict }: { verdict: string | null }) {
  if (!verdict) return <Badge>Pending</Badge>;
  return <Badge tone={verdict === 'APPROVE' ? 'ok' : verdict === 'REQUEST_CHANGES' ? 'bad' : 'neutral'}>{titleCase(verdict)}</Badge>;
}

const SEV_TONE: Record<ReviewFinding['severity'], Tone> = {
  CRITICAL: 'bad',
  HIGH: 'accent',
  MEDIUM: 'warn',
  LOW: 'neutral',
  INFO: 'neutral',
};

export function CodeReviewDetailPage() {
  const { id = '' } = useParams();
  const { data: r, isLoading, error } = useReview(id);
  useDocumentTitle(r?.title ?? 'Code review');
  usePageContext(r ? { title: r.title, entity: { kind: 'code_review', id: r.id, label: r.title }, projectId: r.project.id } : null, [
    r?.id,
  ]);
  if (error)
    return (
      <Page>
        <ErrorState error={error} />
      </Page>
    );
  if (isLoading || !r)
    return (
      <Page>
        <Skeleton className="h-96" />
      </Page>
    );
  const findings = [...r.findings].sort(
    (a, b) =>
      ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(a.severity) - ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO'].indexOf(b.severity),
  );
  return (
    <Page>
      <Link to="/code-reviews" className="text-[12px] text-fg-muted hover:text-fg">
        ← Code reviews
      </Link>
      <div className="mt-2 mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">{r.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
            <VerdictBadge verdict={r.verdict} />
            <RiskBadge level={r.riskLevel} />
            {r.simulated && <ModeBadge mode="DEMO" />}
            <span>{r.repository?.fullName}</span>
            {r.prUrl && (
              <a href={r.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                PR #{r.prNumber} <ExternalLink className="size-3" />
              </a>
            )}
            {r.executionId && (
              <Link to={`/executions/${r.executionId}`} className="hover:text-fg">
                View run →
              </Link>
            )}
          </div>
        </div>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-4">
          {r.summary && (
            <Card className="p-4">
              <MarkdownView>{r.summary}</MarkdownView>
            </Card>
          )}
          {findings.length === 0 && (
            <Card>
              <EmptyState compact icon={<CheckCheck />} title="No findings" description="The reviewer found nothing to flag." />
            </Card>
          )}
          {findings.map((f, i) => (
            <Card key={i} className="p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={SEV_TONE[f.severity]}>{titleCase(f.severity)}</Badge>
                <Badge>{titleCase(f.category)}</Badge>
                <span className="text-[13px] font-semibold">{f.title}</span>
              </div>
              {f.file && (
                <Mono className="mt-1.5 block">
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </Mono>
              )}
              <p className="mt-2 text-[12.5px] leading-relaxed text-fg-muted">{f.detail}</p>
              {f.suggestion && (
                <div className="mt-2 rounded-md border border-ok/25 bg-ok-soft px-3 py-2 text-[12.5px]">
                  <span className="font-medium text-ok">Suggestion: </span>
                  {f.suggestion}
                </div>
              )}
            </Card>
          ))}
        </div>
        <Card className="self-start p-4">
          <div className="label-caps mb-3">Dimensions</div>
          <ul className="space-y-2 text-[12.5px]">
            {Object.entries(r.dimensions ?? {}).map(([k, v]) => (
              <li key={k} className="flex items-center justify-between">
                <span>{titleCase(k)}</span>
                <span className={cn('font-medium capitalize', v === 'passed' ? 'text-ok' : v === 'failed' ? 'text-bad' : 'text-warn')}>
                  {v}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-4 border-t border-line pt-3 text-[11.5px] text-fg-subtle">
            {r.postedToProvider
              ? 'Posted to the pull request.'
              : r.simulated
                ? 'Simulated review — not posted.'
                : 'Not posted to the provider.'}
          </div>
        </Card>
      </div>
    </Page>
  );
}

// ─────────────────────────── QA ───────────────────────────
export function QaPage() {
  useDocumentTitle('Quality');
  usePageContext({ title: 'Quality' });
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<string | null>(null);
  const { data, isLoading, error } = useQaRuns({ projectId: projectId || undefined, status: status || undefined, page, pageSize: 25 });
  return (
    <Page wide>
      <PageHeader
        title="Quality"
        description="Test runs executed by QA agents and validation sandboxes — real results only: if tests did not run, it says so."
        actions={
          <>
            <ProjectFilter value={projectId} onChange={(v) => (setProjectId(v), setPage(1))} />
            <Select
              value={status}
              onChange={(e) => (setStatus(e.target.value), setPage(1))}
              className="h-7 w-36 text-[12px]"
              aria-label="Status"
            >
              <option value="">All statuses</option>
              {['PASSED', 'FAILED', 'ERROR', 'SKIPPED', 'RUNNING'].map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
            <Button size="sm" variant="primary" icon={<CheckCheck className="size-3.5" />} onClick={() => commandLauncher.open('qa.run')}>
              Run QA
            </Button>
          </>
        }
      />
      {error ? (
        <ErrorState error={error} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Run</Th>
                <Th>Status</Th>
                <Th className="w-56">Results</Th>
                <Th className="hidden text-right md:table-cell">Duration</Th>
                <Th className="text-right">When</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton cols={5} />}
              {data?.items.map((q) => (
                <Tr key={q.id} onClick={() => setOpen(q.id)}>
                  <Td>
                    <div className="max-w-[420px] truncate font-medium">{q.title}</div>
                    <div className="flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                      {titleCase(q.type)} · {q.project.name} {q.ref && <Mono>{q.ref}</Mono>}{' '}
                      {q.simulated && <Badge tone="warn">simulated</Badge>}
                    </div>
                  </Td>
                  <Td>
                    <StatusBadge status={q.status} />
                  </Td>
                  <Td>
                    <ResultBar run={q} />
                  </Td>
                  <Td className="hidden text-right font-mono text-[12px] md:table-cell">{formatDuration(q.durationMs)}</Td>
                  <Td className="text-right text-[12px] text-fg-muted">{timeAgo(q.createdAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {data && !data.items.length && <EmptyState compact icon={<CheckCheck />} title="No test runs yet" />}
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </Card>
      )}
      <QaSheet id={open} onClose={() => setOpen(null)} />
    </Page>
  );
}

function ResultBar({ run: q }: { run: Pick<QaRun, 'total' | 'passed' | 'failed' | 'skipped'> }) {
  if (!q.total) return <span className="text-[11.5px] text-fg-subtle">no test results</span>;
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-sunken">
        <span className="bg-ok" style={{ width: `${(q.passed / q.total) * 100}%` }} />
        <span className="bg-bad" style={{ width: `${(q.failed / q.total) * 100}%` }} />
      </div>
      <div className="mt-1 font-mono text-[11px] text-fg-muted">
        {q.passed}/{q.total} passed{q.failed ? ` · ${q.failed} failed` : ''}
        {q.skipped ? ` · ${q.skipped} skipped` : ''}
      </div>
    </div>
  );
}

function QaSheet({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { data: q } = useQuery({ queryKey: ['qa', 'run', id], queryFn: () => api.get<QaRun>(`/qa/runs/${id}`), enabled: Boolean(id) });
  return (
    <Sheet
      open={Boolean(id)}
      onOpenChange={(o) => !o && onClose()}
      title={q?.title ?? 'Test run'}
      subtitle={q ? `${titleCase(q.type)} · ${q.project.name}` : undefined}
      width={640}
    >
      {q && (
        <div className="space-y-5 p-5">
          <div className="flex items-center gap-2">
            <StatusBadge status={q.status} />
            {q.command && <Mono>{q.command}</Mono>}
          </div>
          <ResultBar run={q} />
          {q.analysis?.summary && (
            <div className="rounded-md border border-ai/30 bg-ai-soft px-3 py-2.5 text-[12.5px]">
              <div className="font-medium text-ai">Failure analysis</div>
              <div className="mt-1">{q.analysis.summary}</div>
              {q.analysis.rootCause && <div className="mt-1 text-fg-muted">Root cause: {q.analysis.rootCause}</div>}
            </div>
          )}
          {!!q.testCases?.length && (
            <section>
              <h4 className="label-caps mb-2">Test cases</h4>
              <ul className="divide-y divide-line rounded-md border border-line">
                {q.testCases.map((t) => (
                  <li key={t.id} className="px-3 py-2 text-[12.5px]">
                    <div className="flex items-center gap-2">
                      <Mono>{t.id}</Mono>
                      <span className="flex-1 font-medium">{t.title}</span>
                      <Badge>{t.priority}</Badge>
                    </div>
                    <div className="mt-0.5 text-[11.5px] text-fg-muted">Expected: {t.expected}</div>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {!!q.failures?.length && (
            <section>
              <h4 className="label-caps mb-2">Failures</h4>
              {q.failures.map((f, i) => (
                <pre
                  key={i}
                  className="mb-2 max-h-48 overflow-auto rounded-md border border-bad/30 bg-bad-soft p-2.5 font-mono text-[11px] whitespace-pre-wrap text-bad"
                >
                  {f.name ?? f.check}: {f.message ?? f.output}
                </pre>
              ))}
            </section>
          )}
          {q.output && (
            <section>
              <h4 className="label-caps mb-2">Output</h4>
              <pre className="max-h-80 overflow-auto rounded-md border border-line bg-sunken p-2.5 font-mono text-[11px] whitespace-pre-wrap">
                {q.output}
              </pre>
            </section>
          )}
        </div>
      )}
    </Sheet>
  );
}

// ─────────────────────────── Documents ───────────────────────────
export function DocumentsPage() {
  useDocumentTitle('Docs');
  usePageContext({ title: 'Docs' });
  const navigate = useNavigate();
  const { can } = useAuth();
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [creating, setCreating] = useState(false);
  const { data, isLoading, error } = useDocuments({ projectId: projectId || undefined, search: search || undefined, page, pageSize: 25 });
  return (
    <Page wide>
      <PageHeader
        title="Docs"
        description="Specifications, ADRs, runbooks and guides written by the Docs agent or your team, published to Notion when connected."
        actions={
          <>
            <Input
              value={search}
              onChange={(e) => (setSearch(e.target.value), setPage(1))}
              placeholder="Search…"
              className="h-7 w-48 text-[12px]"
            />
            <ProjectFilter value={projectId} onChange={(v) => (setProjectId(v), setPage(1))} />
            {can('docs:write') && (
              <Button size="sm" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
                New doc
              </Button>
            )}
            <Button
              size="sm"
              variant="primary"
              icon={<FileText className="size-3.5" />}
              onClick={() => commandLauncher.open('docs.generate')}
            >
              Generate docs
            </Button>
          </>
        }
      />
      {error ? (
        <ErrorState error={error} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Document</Th>
                <Th>Type</Th>
                <Th className="hidden md:table-cell">Published</Th>
                <Th className="text-right">Updated</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton cols={4} />}
              {data?.items.map((d) => (
                <Tr key={d.id} onClick={() => navigate(`/documents/${d.id}`)}>
                  <Td>
                    <div className="max-w-[460px] truncate font-medium">{d.title}</div>
                    <div className="text-[11.5px] text-fg-subtle">
                      {d.project?.name ?? 'Workspace'} · v{d.version}
                    </div>
                  </Td>
                  <Td>
                    <Badge>{titleCase(d.type)}</Badge>
                  </Td>
                  <Td className="hidden md:table-cell">
                    {d.externalUrl ? (
                      <a
                        href={d.externalUrl}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center gap-1 text-[12px] text-fg-muted hover:text-fg"
                      >
                        {providerName(d.externalProvider ?? 'external')} <ExternalLink className="size-3" />
                      </a>
                    ) : (
                      <span className="text-[12px] text-fg-subtle">—</span>
                    )}
                  </Td>
                  <Td className="text-right text-[12px] text-fg-muted">{timeAgo(d.updatedAt)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {data && !data.items.length && <EmptyState compact icon={<FileText />} title="No documents yet" />}
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </Card>
      )}
      {creating && <NewDocDialog onClose={() => setCreating(false)} />}
    </Page>
  );
}

function NewDocDialog({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const [form, setForm] = useState({ title: '', type: 'GUIDE', projectId: '', content: '# Title\n\n' });
  const create = useAction(() => api.post<{ id: string }>('/documents', { ...form, projectId: form.projectId || undefined }), {
    success: 'Document created',
    invalidate: [['documents']],
    onSuccess: (d) => (onClose(), navigate(`/documents/${d.id}`)),
  });
  return (
    <Dialog
      open
      wide
      onOpenChange={(o) => !o && onClose()}
      title="New document"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending} disabled={!form.title.trim()} onClick={() => create.mutate(undefined)}>
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          <Field label="Title" required className="col-span-3 sm:col-span-1">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Type">
            <Select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}>
              {DOCUMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Project">
            <Select value={form.projectId} onChange={(e) => setForm({ ...form, projectId: e.target.value })}>
              <option value="">Workspace</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="Content (Markdown)">
          <Textarea
            value={form.content}
            onChange={(e) => setForm({ ...form, content: e.target.value })}
            rows={12}
            className="font-mono text-[12px]"
          />
        </Field>
      </div>
    </Dialog>
  );
}

export function DocumentDetailPage() {
  const { id = '' } = useParams();
  const { can } = useAuth();
  const { data: d, isLoading, error } = useDocument(id);
  const [editing, setEditing] = useState(false);
  const [content, setContent] = useState('');
  useDocumentTitle(d?.title ?? 'Document');
  usePageContext(d ? { title: d.title, entity: { kind: 'document', id: d.id, label: d.title }, projectId: d.project?.id } : null, [d?.id]);
  const save = useAction(() => api.patch(`/documents/${id}`, { title: d!.title, content }), {
    success: 'Saved as a new version',
    invalidate: [qk.document(id), ['documents']],
    onSuccess: () => setEditing(false),
  });
  if (error)
    return (
      <Page>
        <ErrorState error={error} />
      </Page>
    );
  if (isLoading || !d)
    return (
      <Page>
        <Skeleton className="h-96" />
      </Page>
    );
  return (
    <Page>
      <Link to="/documents" className="text-[12px] text-fg-muted hover:text-fg">
        ← Docs
      </Link>
      <div className="mt-2 mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{d.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-[12px] text-fg-muted">
            <Badge>{titleCase(d.type)}</Badge>
            <span>v{d.version}</span>
            <span>updated {timeAgo(d.updatedAt)}</span>
            {d.externalUrl && (
              <a href={d.externalUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-fg">
                Open in {providerName(d.externalProvider ?? 'provider')} <ExternalLink className="size-3" />
              </a>
            )}
            {d.executionId && (
              <Link to={`/executions/${d.executionId}`} className="hover:text-fg">
                Generated by run →
              </Link>
            )}
          </div>
        </div>
        {can('docs:write') &&
          (editing ? (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                icon={<Save className="size-3.5" />}
                loading={save.isPending}
                onClick={() => save.mutate(undefined)}
              >
                Save
              </Button>
            </div>
          ) : (
            <Button icon={<Pencil className="size-3.5" />} onClick={() => (setContent(d.content), setEditing(true))}>
              Edit
            </Button>
          ))}
      </div>
      <Card className="p-6">
        {editing ? (
          <Textarea value={content} onChange={(e) => setContent(e.target.value)} rows={28} className="font-mono text-[12.5px]" />
        ) : (
          <MarkdownView className="max-w-3xl">{d.content}</MarkdownView>
        )}
      </Card>
    </Page>
  );
}

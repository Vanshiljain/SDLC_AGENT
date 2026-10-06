import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { FolderKanban, GitBranch, Plus } from 'lucide-react';
import { api } from '@/api/client';
import { qk, useAction, useProjects } from '@/api/queries';
import type { ProjectHealth, ProjectSummary } from '@/api/types';
import { cn } from '@/lib/cn';
import { formatPercent, timeAgo } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch, Textarea } from '@/components/ui/form';
import { Badge, Card, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader } from '@/components/ui/page';
import { StatusDot } from '@/components/ui/status';

export function HealthRing({ health, size = 44 }: { health: ProjectHealth; size?: number }) {
  const r = (size - 6) / 2;
  const c = 2 * Math.PI * r;
  const score = health.score ?? 0;
  const color =
    health.score === null
      ? 'var(--color-line-strong)'
      : score >= 80
        ? 'var(--color-ok)'
        : score >= 50
          ? 'var(--color-warn)'
          : 'var(--color-bad)';
  return (
    <div
      className="relative shrink-0"
      style={{ width: size, height: size }}
      title={
        health.score === null
          ? 'Not enough activity to score health yet'
          : `Health ${health.score}/100 (${health.status.replace('_', ' ')})`
      }
    >
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={3} />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - score / 100)}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-[12px] font-medium">{health.score ?? '—'}</span>
    </div>
  );
}

export function ProjectsPage() {
  useDocumentTitle('Projects');
  usePageContext({ title: 'Projects' });
  const { can } = useAuth();
  const { data, isLoading, error, refetch } = useProjects();
  const [creating, setCreating] = useState(false);
  return (
    <Page wide>
      <PageHeader
        title="Projects"
        description="Services Vanshil’s SDLC delivers: repositories, environments, ticket and CI/CD settings, and who can do what."
        actions={
          can('project:create') && (
            <Button variant="primary" icon={<Plus className="size-3.5" />} onClick={() => setCreating(true)}>
              New project
            </Button>
          )
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={i} className="h-48" />
          ))}
        </div>
      ) : !data?.length ? (
        <Card>
          <EmptyState
            icon={<FolderKanban />}
            title="Create your first project"
            description="A project groups a repository, its environments and its delivery settings. Connect GitHub first to pick a repository."
            action={
              can('project:create') && (
                <Button variant="primary" onClick={() => setCreating(true)}>
                  New project
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {data.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      )}
      <NewProjectDialog open={creating} onClose={() => setCreating(false)} />
    </Page>
  );
}

function ProjectCard({ project: p }: { project: ProjectSummary }) {
  return (
    <Link to={`/projects/${p.id}`} className="block">
      <Card className="h-full p-4 transition-colors hover:border-line-strong">
        <div className="flex items-start gap-3">
          <HealthRing health={p.health} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-[14px] font-semibold tracking-tight">{p.name}</span>
              <Mono>{p.key}</Mono>
            </div>
            <p className="mt-0.5 line-clamp-2 text-[12px] text-fg-muted">{p.description ?? 'No description'}</p>
          </div>
        </div>
        <div className="mt-4 space-y-1.5 text-[12px]">
          {p.repositories.map((r) => (
            <div key={r.id} className="flex items-center gap-1.5 text-fg-muted">
              <GitBranch className="size-3.5 text-fg-subtle" />
              <span className="truncate font-mono text-[11.5px]">{r.fullName}</span>
              {r.language && <span className="text-fg-subtle">· {r.language}</span>}
            </div>
          ))}
          {!p.repositories.length && <div className="text-fg-subtle">No repository linked</div>}
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5">
          {p.environments.map((e) => {
            const dep = p.health.deployments.find((d) => d.environment === e.name);
            return (
              <Badge key={e.id} icon={dep ? <StatusDot status={dep.status} className="size-1.5" /> : undefined}>
                {e.name}
              </Badge>
            );
          })}
        </div>
        <div className="mt-4 grid grid-cols-3 border-t border-line pt-3 text-[11.5px]">
          <div>
            <div className="text-fg-subtle">Runs · 14d</div>
            <div className="font-mono text-[13px]">{p.health.runs14d}</div>
          </div>
          <div>
            <div className="text-fg-subtle">Success</div>
            <div className={cn('font-mono text-[13px]', (p.health.successRate ?? 1) < 0.7 && 'text-bad')}>
              {formatPercent(p.health.successRate)}
            </div>
          </div>
          <div>
            <div className="text-fg-subtle">Last QA</div>
            <div className="truncate text-[12px]">
              {p.health.lastQa
                ? `${p.health.lastQa.passed} ✓ ${p.health.lastQa.failed ? `${p.health.lastQa.failed} ✗ ` : ''}· ${timeAgo(p.health.lastQa.createdAt)}`
                : '—'}
            </div>
          </div>
        </div>
      </Card>
    </Link>
  );
}

function NewProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const [form, setForm] = useState({
    name: '',
    key: '',
    description: '',
    ticketProvider: 'JIRA',
    jiraProjectKey: '',
    cicdProvider: 'GITHUB_ACTIONS',
    envs: true,
  });
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));
  const keyFromName = (n: string) =>
    n
      .replace(/[^A-Za-z0-9 ]/g, '')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w[0])
      .join('')
      .toUpperCase()
      .slice(0, 6) || '';
  const create = useAction(
    () =>
      api.post<{ id: string }>('/projects', {
        name: form.name,
        key: form.key,
        description: form.description || undefined,
        createDefaultEnvironments: form.envs,
        settings: {
          ticketProvider: form.ticketProvider,
          cicdProvider: form.cicdProvider,
          ...(form.jiraProjectKey && { jiraProjectKey: form.jiraProjectKey }),
        },
      }),
    { success: 'Project created', invalidate: [qk.projects], onSuccess: (p) => (onClose(), navigate(`/projects/${p.id}`)) },
  );
  const validKey = /^[A-Z][A-Z0-9]{1,9}$/.test(form.key);
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="New project"
      description="You can link a repository and configure environments next."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            disabled={form.name.trim().length < 2 || !validKey}
            onClick={() => create.mutate(undefined)}
          >
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Name" required>
            <Input
              value={form.name}
              autoFocus
              onChange={(e) =>
                setForm((f) => ({
                  ...f,
                  name: e.target.value,
                  key: f.key && f.key !== keyFromName(f.name) ? f.key : keyFromName(e.target.value),
                }))
              }
              placeholder="Authentication Service"
            />
          </Field>
          <Field label="Key" required error={form.key && !validKey ? '2–10 caps' : null}>
            <Input value={form.key} className="font-mono" onChange={(e) => set('key', e.target.value.toUpperCase())} placeholder="AUTH" />
          </Field>
        </div>
        <Field label="Description">
          <Textarea rows={2} value={form.description} onChange={(e) => set('description', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Tickets">
            <Select value={form.ticketProvider} onChange={(e) => set('ticketProvider', e.target.value)}>
              <option value="JIRA">Jira</option>
              <option value="TRELLO">Trello</option>
            </Select>
          </Field>
          <Field label="CI/CD">
            <Select value={form.cicdProvider} onChange={(e) => set('cicdProvider', e.target.value)}>
              <option value="GITHUB_ACTIONS">GitHub Actions</option>
              <option value="CUSTOM_DEVOPS">Custom DevOps platform</option>
            </Select>
          </Field>
        </div>
        {form.ticketProvider === 'JIRA' && (
          <Field label="Jira project key" hint="Tickets are created in this Jira project.">
            <Input
              value={form.jiraProjectKey}
              className="font-mono"
              onChange={(e) => set('jiraProjectKey', e.target.value.toUpperCase())}
              placeholder={form.key || 'AUTH'}
            />
          </Field>
        )}
        <label className="flex items-center justify-between rounded-md border border-line px-3 py-2.5">
          <span>
            <span className="block text-[12.5px] font-medium">Create default environments</span>
            <span className="block text-[11.5px] text-fg-subtle">development, staging and production (production requires approval)</span>
          </span>
          <Switch checked={form.envs} onCheckedChange={(v) => set('envs', v)} label="Create default environments" />
        </label>
      </div>
    </Dialog>
  );
}

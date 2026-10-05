import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink, GitBranch, Lock, Plus, Rocket, Trash2, UserPlus, Zap } from 'lucide-react';
import { ENVIRONMENT_TYPES, PROJECT_ROLES, type EnvironmentType, type ProjectRole } from '@forgeline/shared';
import { api } from '@/api/client';
import { qk, useAction, useExecutions, useMembers, useProject } from '@/api/queries';
import type { Environment, ProjectDetail, ProjectSettings, Repository, RepositorySettings, SmokeTest } from '@/api/types';
import { useAuth } from '@/lib/auth';
import { formatDuration, durationBetween, timeAgo, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Switch } from '@/components/ui/form';
import { Avatar, Badge, Card, CardHeader, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page } from '@/components/ui/page';
import { ModeBadge, StatusBadge, StatusDot } from '@/components/ui/status';
import { TabsContent, TabsList, TabsRoot } from '@/components/ui/tabs';
import { commandLauncher } from '@/features/run-command';

export function ProjectDetailPage() {
  const { id = '' } = useParams();
  const { data: p, isLoading, error, refetch } = useProject(id);
  const { can } = useAuth();
  useDocumentTitle(p?.name ?? 'Project');
  usePageContext(p ? { title: p.name, entity: { kind: 'project', id: p.id, label: p.name }, projectId: p.id } : null, [p?.id]);
  if (error)
    return (
      <Page>
        <ErrorState error={error} onRetry={() => void refetch()} />
      </Page>
    );
  if (isLoading || !p)
    return (
      <Page>
        <Skeleton className="h-64" />
      </Page>
    );
  const manage = can('project:manage');
  return (
    <Page wide>
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link to="/projects" className="text-[12px] text-fg-muted hover:text-fg">
            ← Projects
          </Link>
          <div className="mt-2 flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-[-0.02em]">{p.name}</h1>
            <Mono className="text-[13px]">{p.key}</Mono>
          </div>
          {p.description && <p className="mt-1 max-w-2xl text-[13px] text-fg-muted">{p.description}</p>}
        </div>
        <div className="flex gap-2">
          <Button icon={<Rocket className="size-3.5" />} onClick={() => commandLauncher.open('deploy.environment', { projectId: p.id })}>
            Deploy
          </Button>
          <Button
            variant="primary"
            icon={<Zap className="size-3.5" />}
            onClick={() => commandLauncher.open('feature.deliver', { projectId: p.id })}
          >
            Deliver a feature
          </Button>
        </div>
      </div>
      <TabsRoot defaultValue="overview">
        <TabsList
          tabs={[
            { value: 'overview', label: 'Overview' },
            { value: 'repository', label: 'Repository', count: p.repositories.length },
            { value: 'environments', label: 'Environments', count: p.environments.length },
            { value: 'members', label: 'Members', count: p.members.length },
            { value: 'settings', label: 'Settings' },
          ]}
        />
        <TabsContent value="overview" className="pt-5">
          <Overview project={p} />
        </TabsContent>
        <TabsContent value="repository" className="pt-5">
          <Repositories project={p} manage={manage} />
        </TabsContent>
        <TabsContent value="environments" className="pt-5">
          <Environments project={p} manage={manage} />
        </TabsContent>
        <TabsContent value="members" className="pt-5">
          <Members project={p} manage={manage} />
        </TabsContent>
        <TabsContent value="settings" className="pt-5">
          <Settings project={p} manage={manage} />
        </TabsContent>
      </TabsRoot>
    </Page>
  );
}

function Overview({ project: p }: { project: ProjectDetail }) {
  const runs = useExecutions({ projectId: p.id, pageSize: 8 });
  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_380px]">
      <Card>
        <CardHeader
          title="Recent runs"
          actions={
            <Link to="/executions" className="text-[12px] text-fg-muted hover:text-fg">
              All →
            </Link>
          }
        />
        {runs.data && !runs.data.items.length ? (
          <EmptyState
            compact
            icon={<Zap />}
            title="No runs yet"
            description="Deliver a feature, review a PR or deploy — runs for this project show up here."
          />
        ) : (
          <ul className="divide-y divide-line border-t border-line">
            {runs.data?.items.map((r) => (
              <li key={r.id}>
                <Link to={`/executions/${r.id}`} className="flex items-center gap-3 px-4 py-2.5 text-[13px] hover:bg-sunken/60">
                  <StatusDot status={r.status} />
                  <span className="min-w-0 flex-1 truncate">{r.title}</span>
                  <ModeBadge mode={r.mode} />
                  <span className="font-mono text-[11.5px] text-fg-subtle">
                    {formatDuration(durationBetween(r.startedAt, r.completedAt))}
                  </span>
                  <span className="w-24 text-right text-[11.5px] text-fg-subtle">{timeAgo(r.createdAt)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader title="Environments" />
        <ul className="divide-y divide-line border-t border-line">
          {p.environments.map((e) => {
            const d = p.latestDeployments.find((x) => x.environmentId === e.id);
            return (
              <li key={e.id} className="px-4 py-3">
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-medium">{e.name}</span>
                  {e.requiresApproval && <Badge tone="accent">gated</Badge>}
                  <span className="ml-auto">
                    {d ? <StatusBadge status={d.status} /> : <span className="text-[11.5px] text-fg-subtle">never deployed</span>}
                  </span>
                </div>
                {d && (
                  <div className="mt-1 flex items-center gap-2 text-[11.5px] text-fg-subtle">
                    <Mono>{d.version}</Mono> · {timeAgo(d.createdAt)} {d.simulated && <span className="text-warn">· simulated</span>}
                  </div>
                )}
              </li>
            );
          })}
          {!p.environments.length && <li className="px-4 py-6 text-center text-[12px] text-fg-subtle">No environments.</li>}
        </ul>
      </Card>
    </div>
  );
}

// ─────────────── Repository ───────────────
function Repositories({ project: p, manage }: { project: ProjectDetail; manage: boolean }) {
  const [linking, setLinking] = useState(false);
  const unlink = useAction((r: Repository) => api.del(`/projects/${p.id}/repositories/${r.id}`), {
    success: 'Repository unlinked',
    invalidate: [qk.project(p.id), qk.projects],
  });
  return (
    <div className="space-y-4">
      {p.repositories.map((r) => (
        <RepoCard key={r.id} project={p} repo={r} manage={manage} onUnlink={() => unlink.mutate(r)} />
      ))}
      {!p.repositories.length && (
        <Card>
          <EmptyState
            compact
            icon={<GitBranch />}
            title="Link a repository"
            description="Agents read, branch, commit and open pull requests here. Requires a connected GitHub integration."
            action={
              manage && (
                <Button variant="primary" onClick={() => setLinking(true)}>
                  Link repository
                </Button>
              )
            }
          />
        </Card>
      )}
      {p.repositories.length > 0 && manage && (
        <Button icon={<Plus className="size-3.5" />} onClick={() => setLinking(true)}>
          Link another repository
        </Button>
      )}
      <LinkRepoDialog project={p} open={linking} onClose={() => setLinking(false)} />
    </div>
  );
}

const REPO_FIELDS: { key: keyof RepositorySettings; label: string; placeholder: string }[] = [
  { key: 'installCommand', label: 'Install', placeholder: 'npm ci' },
  { key: 'lintCommand', label: 'Lint', placeholder: 'npm run lint' },
  { key: 'typecheckCommand', label: 'Typecheck', placeholder: 'npx tsc --noEmit' },
  { key: 'testCommand', label: 'Test', placeholder: 'npm test' },
  { key: 'buildCommand', label: 'Build', placeholder: 'npm run build' },
  { key: 'sandboxImage', label: 'Sandbox image', placeholder: 'node:22-bookworm' },
  { key: 'ciWorkflow', label: 'CI workflow', placeholder: 'ci.yml' },
  { key: 'deployWorkflow', label: 'Deploy workflow', placeholder: 'deploy.yml' },
];

function RepoCard({
  project: p,
  repo: r,
  manage,
  onUnlink,
}: {
  project: ProjectDetail;
  repo: Repository;
  manage: boolean;
  onUnlink: () => void;
}) {
  const [settings, setSettings] = useState<RepositorySettings>(r.settings ?? {});
  const [branch, setBranch] = useState(r.defaultBranch);
  const save = useAction(() => api.patch(`/projects/${p.id}/repositories/${r.id}`, { defaultBranch: branch, settings }), {
    success: 'Repository settings saved',
    invalidate: [qk.project(p.id)],
  });
  return (
    <Card>
      <CardHeader
        icon={<GitBranch className="size-4" />}
        title={
          <a
            href={r.url ?? undefined}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono hover:text-accent"
          >
            {r.fullName} <ExternalLink className="size-3" />
          </a>
        }
        description={`${r.language ?? 'Unknown language'} · ${r.lastIndexedAt ? `indexed ${timeAgo(r.lastIndexedAt)}` : 'not indexed into Knowledge yet'}`}
        actions={
          manage && (
            <Button size="sm" variant="danger-ghost" icon={<Trash2 className="size-3.5" />} onClick={onUnlink}>
              Unlink
            </Button>
          )
        }
      />
      <fieldset disabled={!manage} className="grid gap-3 border-t border-line p-4 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Default branch">
          <Input value={branch} className="font-mono text-[12px]" onChange={(e) => setBranch(e.target.value)} />
        </Field>
        {REPO_FIELDS.map((f) => (
          <Field key={f.key} label={f.label}>
            <Input
              value={settings[f.key] ?? ''}
              placeholder={f.placeholder}
              className="font-mono text-[12px]"
              onChange={(e) => setSettings((s) => ({ ...s, [f.key]: e.target.value || undefined }))}
            />
          </Field>
        ))}
      </fieldset>
      {manage && (
        <div className="flex items-center justify-between border-t border-line px-4 py-2.5">
          <span className="text-[11.5px] text-fg-subtle">
            Commands run in an isolated sandbox to validate generated code before it is committed.
          </span>
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function LinkRepoDialog({ project: p, open, onClose }: { project: ProjectDetail; open: boolean; onClose: () => void }) {
  const repos = useQuery({
    queryKey: ['github-repos'],
    queryFn: () =>
      api.get<{ fullName: string; private: boolean; defaultBranch: string; language: string | null; description: string | null }[]>(
        '/integrations/github/repositories',
      ),
    enabled: open,
    retry: false,
  });
  const [fullName, setFullName] = useState('');
  const link = useAction(() => api.post(`/projects/${p.id}/repositories`, { fullName }), {
    success: 'Repository linked',
    invalidate: [qk.project(p.id), qk.projects],
    onSuccess: onClose,
  });
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Link a GitHub repository"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={link.isPending}
            disabled={!/^[\w.-]+\/[\w.-]+$/.test(fullName)}
            onClick={() => link.mutate(undefined)}
          >
            Link
          </Button>
        </>
      }
    >
      {repos.error ? (
        <div className="space-y-3">
          <p className="rounded-md bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
            Couldn’t list repositories — connect GitHub under Integrations first, or type the repository name.
          </p>
          <Field label="Repository (owner/name)">
            <Input value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="acme/auth-service" className="font-mono" />
          </Field>
        </div>
      ) : repos.isLoading ? (
        <Skeleton className="h-48" />
      ) : (
        <div className="max-h-[50vh] space-y-1 overflow-y-auto">
          {repos.data?.map((r) => (
            <button
              key={r.fullName}
              type="button"
              onClick={() => setFullName(r.fullName)}
              className={`flex w-full items-start gap-2 rounded-md border px-3 py-2 text-left ${fullName === r.fullName ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong'}`}
            >
              <GitBranch className="mt-0.5 size-3.5 text-fg-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block font-mono text-[12.5px]">{r.fullName}</span>
                <span className="block truncate text-[11.5px] text-fg-subtle">{r.description ?? r.language ?? ''}</span>
              </span>
              {r.private && <Lock className="size-3 text-fg-subtle" />}
            </button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

// ─────────────── Environments ───────────────
function Environments({ project: p, manage }: { project: ProjectDetail; manage: boolean }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-4">
      {p.environments.map((e) => (
        <EnvCard key={e.id} project={p} env={e} manage={manage} />
      ))}
      {manage && (
        <Button icon={<Plus className="size-3.5" />} onClick={() => setAdding(true)}>
          Add environment
        </Button>
      )}
      <AddEnvDialog project={p} open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function EnvCard({ project: p, env, manage }: { project: ProjectDetail; env: Environment; manage: boolean }) {
  const [url, setUrl] = useState(env.url ?? '');
  const [health, setHealth] = useState(env.healthCheckPath ?? '/health');
  const [gated, setGated] = useState(env.requiresApproval);
  const [smoke, setSmoke] = useState<SmokeTest[]>(env.smokeTests ?? []);
  const save = useAction(
    () =>
      api.patch(`/projects/${p.id}/environments/${env.id}`, {
        url: url || undefined,
        healthCheckPath: health || undefined,
        requiresApproval: gated,
        smokeTests: smoke,
      }),
    { success: `${env.name} saved`, invalidate: [qk.project(p.id)] },
  );
  return (
    <Card>
      <CardHeader
        title={env.name}
        description={titleCase(env.type)}
        actions={
          env.type === 'PRODUCTION' && (
            <Badge tone="accent" icon={<Lock className="size-3" />}>
              always gated
            </Badge>
          )
        }
      />
      <fieldset disabled={!manage} className="space-y-4 border-t border-line p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_200px_auto]">
          <Field label="URL">
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://staging.example.com" />
          </Field>
          <Field label="Health check path">
            <Input value={health} className="font-mono text-[12px]" onChange={(e) => setHealth(e.target.value)} />
          </Field>
          <div className="flex items-end gap-2 pb-1.5">
            <Switch
              checked={gated || env.type === 'PRODUCTION'}
              disabled={env.type === 'PRODUCTION'}
              onCheckedChange={setGated}
              label="Requires approval"
            />
            <span className="text-[12px] text-fg-muted">Requires approval</span>
          </div>
        </div>
        <div>
          <div className="label-caps mb-2">Smoke tests</div>
          <div className="space-y-2">
            {smoke.map((t, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_90px_auto] gap-2">
                <Input
                  value={t.name}
                  placeholder="Name"
                  onChange={(e) => setSmoke((s) => s.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                  aria-label="Smoke test name"
                />
                <Input
                  value={t.path}
                  placeholder="/login"
                  className="font-mono text-[12px]"
                  onChange={(e) => setSmoke((s) => s.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))}
                  aria-label="Path"
                />
                <Input
                  type="number"
                  value={t.expectStatus ?? 200}
                  onChange={(e) => setSmoke((s) => s.map((x, j) => (j === i ? { ...x, expectStatus: Number(e.target.value) } : x)))}
                  aria-label="Expected status"
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label="Remove smoke test"
                  onClick={() => setSmoke((s) => s.filter((_, j) => j !== i))}
                  icon={<Trash2 className="size-3.5" />}
                />
              </div>
            ))}
            <Button
              size="sm"
              variant="ghost"
              icon={<Plus className="size-3.5" />}
              onClick={() => setSmoke((s) => [...s, { name: 'New check', path: '/', expectStatus: 200 }])}
            >
              Add smoke test
            </Button>
          </div>
        </div>
      </fieldset>
      {manage && (
        <div className="flex justify-end border-t border-line px-4 py-2.5">
          <Button size="sm" variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function AddEnvDialog({ project: p, open, onClose }: { project: ProjectDetail; open: boolean; onClose: () => void }) {
  const [name, setName] = useState('');
  const [type, setType] = useState<EnvironmentType>('STAGING');
  const [url, setUrl] = useState('');
  const add = useAction(
    () => api.post(`/projects/${p.id}/environments`, { name, type, url: url || undefined, requiresApproval: type === 'PRODUCTION' }),
    { success: 'Environment added', invalidate: [qk.project(p.id), qk.projects], onSuccess: onClose },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Add environment"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={add.isPending}
            disabled={!/^[a-z][a-z0-9-]{1,30}$/.test(name)}
            onClick={() => add.mutate(undefined)}
          >
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Name" hint="lowercase, e.g. qa or eu-staging">
            <Input value={name} onChange={(e) => setName(e.target.value.toLowerCase())} />
          </Field>
          <Field label="Type">
            <Select value={type} onChange={(e) => setType(e.target.value as EnvironmentType)}>
              {ENVIRONMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {titleCase(t)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        <Field label="URL">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://qa.example.com" />
        </Field>
      </div>
    </Dialog>
  );
}

// ─────────────── Members ───────────────
function Members({ project: p, manage }: { project: ProjectDetail; manage: boolean }) {
  const org = useMembers();
  const [userId, setUserId] = useState('');
  const [role, setRole] = useState<ProjectRole>('DEVELOPER');
  const inv = [qk.project(p.id)];
  const upsert = useAction((v: { userId: string; role: ProjectRole }) => api.put(`/projects/${p.id}/members`, v), {
    success: 'Member updated',
    invalidate: inv,
    onSuccess: () => setUserId(''),
  });
  const remove = useAction((uid: string) => api.del(`/projects/${p.id}/members/${uid}`), { success: 'Member removed', invalidate: inv });
  const candidates = (org.data?.members ?? []).filter((m) => !p.members.some((x) => x.userId === m.user.id));
  return (
    <Card>
      <ul className="divide-y divide-line">
        {p.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-2.5">
            <Avatar name={m.user.name} size={28} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-medium">{m.user.name}</div>
              <div className="text-[11.5px] text-fg-subtle">{m.user.email}</div>
            </div>
            <Select
              value={m.role}
              disabled={!manage}
              onChange={(e) => upsert.mutate({ userId: m.userId, role: e.target.value as ProjectRole })}
              className="h-7 w-36 text-[12px]"
              aria-label="Project role"
            >
              {PROJECT_ROLES.map((r) => (
                <option key={r} value={r}>
                  {titleCase(r)}
                </option>
              ))}
            </Select>
            {manage && (
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Remove ${m.user.name}`}
                onClick={() => remove.mutate(m.userId)}
                icon={<Trash2 className="size-3.5" />}
              />
            )}
          </li>
        ))}
      </ul>
      {manage && (
        <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
          <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="h-8 w-60" aria-label="Organization member">
            <option value="">Add a workspace member…</option>
            {candidates.map((m) => (
              <option key={m.user.id} value={m.user.id}>
                {m.user.name}
              </option>
            ))}
          </Select>
          <Select value={role} onChange={(e) => setRole(e.target.value as ProjectRole)} className="h-8 w-36" aria-label="Role">
            {PROJECT_ROLES.map((r) => (
              <option key={r} value={r}>
                {titleCase(r)}
              </option>
            ))}
          </Select>
          <Button
            icon={<UserPlus className="size-3.5" />}
            disabled={!userId}
            loading={upsert.isPending}
            onClick={() => upsert.mutate({ userId, role })}
          >
            Add
          </Button>
          <span className="ml-auto text-[11.5px] text-fg-subtle">
            Maintainers can merge and deploy to production; developers can deploy to staging.
          </span>
        </div>
      )}
    </Card>
  );
}

// ─────────────── Settings ───────────────
function Settings({ project: p, manage }: { project: ProjectDetail; manage: boolean }) {
  const [s, setS] = useState<ProjectSettings>(p.settings ?? {});
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description ?? '');
  const policy = useQuery({
    queryKey: ['approvals', 'policy', p.id],
    queryFn: () => api.get<{ action: string; setting: 'auto' | 'required'; locked: boolean }[]>('/approvals/policy', { projectId: p.id }),
  });
  useEffect(() => setS(p.settings ?? {}), [p.settings]);
  const save = useAction(() => api.patch(`/projects/${p.id}`, { name, description, settings: s }), {
    success: 'Project settings saved',
    invalidate: [qk.project(p.id), qk.projects, ['approvals', 'policy', p.id]],
  });
  const set = <K extends keyof ProjectSettings>(k: K, v: ProjectSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <Card>
        <CardHeader title="General" />
        <fieldset disabled={!manage} className="space-y-4 border-t border-line p-4">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Description">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Ticket system">
              <Select value={s.ticketProvider ?? 'JIRA'} onChange={(e) => set('ticketProvider', e.target.value as 'JIRA' | 'TRELLO')}>
                <option value="JIRA">Jira</option>
                <option value="TRELLO">Trello</option>
              </Select>
            </Field>
            <Field label="CI/CD">
              <Select
                value={s.cicdProvider ?? 'GITHUB_ACTIONS'}
                onChange={(e) => set('cicdProvider', e.target.value as 'CUSTOM_DEVOPS' | 'GITHUB_ACTIONS')}
              >
                <option value="GITHUB_ACTIONS">GitHub Actions</option>
                <option value="CUSTOM_DEVOPS">Custom DevOps platform</option>
              </Select>
            </Field>
          </div>
          {(s.ticketProvider ?? 'JIRA') === 'JIRA' ? (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Jira project key">
                <Input
                  value={s.jiraProjectKey ?? ''}
                  className="font-mono"
                  onChange={(e) => set('jiraProjectKey', e.target.value.toUpperCase() || undefined)}
                />
              </Field>
              <Field label="Issue type">
                <Input
                  value={s.jiraIssueType ?? ''}
                  placeholder="Story"
                  onChange={(e) => set('jiraIssueType', e.target.value || undefined)}
                />
              </Field>
            </div>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              <Field label="Board ID">
                <Input
                  value={s.trelloBoardId ?? ''}
                  className="font-mono text-[12px]"
                  onChange={(e) => set('trelloBoardId', e.target.value || undefined)}
                />
              </Field>
              <Field label="To-do list ID">
                <Input
                  value={s.trelloListId ?? ''}
                  className="font-mono text-[12px]"
                  onChange={(e) => set('trelloListId', e.target.value || undefined)}
                />
              </Field>
              <Field label="Done list ID">
                <Input
                  value={s.trelloDoneListId ?? ''}
                  className="font-mono text-[12px]"
                  onChange={(e) => set('trelloDoneListId', e.target.value || undefined)}
                />
              </Field>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Notion parent page" hint="Docs are published under this page">
              <Input
                value={s.notionParentPageId ?? ''}
                className="font-mono text-[12px]"
                onChange={(e) => set('notionParentPageId', e.target.value || undefined)}
              />
            </Field>
            <Field label="Slack channel">
              <Input
                value={s.slackChannel ?? ''}
                placeholder="#releases"
                onChange={(e) => set('slackChannel', e.target.value || undefined)}
              />
            </Field>
          </div>
        </fieldset>
      </Card>
      <Card>
        <CardHeader
          title="Approval policy"
          description="Which actions pause for a human. Locked actions always require approval — no flow or project setting can remove them."
        />
        <ul className="divide-y divide-line border-t border-line">
          {policy.isLoading && (
            <li className="p-4">
              <Skeleton className="h-32" />
            </li>
          )}
          {policy.data?.map((row) => {
            const value = row.locked ? 'required' : (s.approvalPolicy?.[row.action] ?? row.setting);
            return (
              <li key={row.action} className="flex items-center gap-3 px-4 py-2.5">
                <Mono className="flex-1 text-fg">{row.action}</Mono>
                {row.locked ? (
                  <Badge tone="accent" icon={<Lock className="size-3" />}>
                    Always required
                  </Badge>
                ) : (
                  <label className="flex items-center gap-2 text-[12px] text-fg-muted">
                    {value === 'required' ? 'Requires approval' : 'Automatic'}
                    <Switch
                      checked={value === 'required'}
                      disabled={!manage}
                      onCheckedChange={(v) => set('approvalPolicy', { ...(s.approvalPolicy ?? {}), [row.action]: v ? 'required' : 'auto' })}
                      label={`Require approval for ${row.action}`}
                    />
                  </label>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      {manage && (
        <div className="flex justify-end lg:col-span-2">
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
            Save settings
          </Button>
        </div>
      )}
    </div>
  );
}

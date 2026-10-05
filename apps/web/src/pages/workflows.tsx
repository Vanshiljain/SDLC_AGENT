import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { BookText, CalendarClock, ClipboardList, CloudUpload, FileSearch, FlaskConical, GitPullRequestArrow, ListChecks, Megaphone, Play, Plus, Rocket, ScanSearch, Sparkles, Ticket, Webhook, Workflow as WorkflowIcon, Zap, type LucideIcon } from 'lucide-react';
import { api } from '@/api/client';
import { qk, useAction, useCommands, useProjects, useTemplates, useWorkflows } from '@/api/queries';
import type { FlowTemplate, Workflow } from '@/api/types';
import { timeAgo, titleCase, providerName } from '@/lib/format';
import { useAuth } from '@/lib/auth';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/form';
import { Badge, Card, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader, Section } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status';
import { commandLauncher } from '@/features/run-command';
import { setBuilderDraft } from './flow-builder';

const TEMPLATE_ICONS: Record<string, LucideIcon> = {
  rocket: Rocket,
  ticket: Ticket,
  'file-text': FileSearch,
  'list-checks': ListChecks,
  'scan-search': ScanSearch,
  'git-pull-request': GitPullRequestArrow,
  'flask-conical': FlaskConical,
  'cloud-upload': CloudUpload,
  workflow: WorkflowIcon,
  'book-open': BookText,
  megaphone: Megaphone,
  clipboard: ClipboardList,
};

export function WorkflowsPage() {
  useDocumentTitle('Flows');
  usePageContext({ title: 'Flows' });
  const navigate = useNavigate();
  const { can } = useAuth();
  const workflows = useWorkflows();
  const templates = useTemplates();
  const commands = useCommands();
  const [generating, setGenerating] = useState(false);

  const clone = useAction((t: FlowTemplate) => api.post<Workflow>(`/workflows/templates/${t.key}/clone`, {}), {
    success: 'Template copied to your flows',
    invalidate: [qk.workflows],
    onSuccess: (wf) => navigate(`/workflows/${wf.id}`),
  });

  const runTemplate = (t: FlowTemplate) => {
    const cmd = commands.data?.commands.find((c) => c.template === t.key);
    if (cmd) commandLauncher.open(cmd.id);
    else clone.mutate(t);
  };

  return (
    <Page wide>
      <PageHeader
        title="Flows"
        description="Reusable delivery workflows. Agents execute each step; approvals, retries and self-healing are built in."
        actions={
          can('workflow:manage') && (
            <>
              <Button icon={<Sparkles className="size-3.5 text-ai" />} onClick={() => setGenerating(true)}>
                Describe a flow
              </Button>
              <Link to="/workflows/new">
                <Button variant="primary" icon={<Plus className="size-3.5" />}>
                  New flow
                </Button>
              </Link>
            </>
          )
        }
      />

      <Section title="Your flows">
        {workflows.error ? (
          <ErrorState error={workflows.error} onRetry={() => void workflows.refetch()} />
        ) : workflows.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }, (_, i) => (
              <Skeleton key={i} className="h-36" />
            ))}
          </div>
        ) : !workflows.data?.length ? (
          <Card>
            <EmptyState
              compact
              icon={<WorkflowIcon />}
              title="No saved flows yet"
              description="Start from a template below, draw one in the builder, or describe it in plain English and let Forge draft it."
              action={
                <Button variant="primary" icon={<Sparkles className="size-3.5" />} onClick={() => setGenerating(true)}>
                  Describe a flow
                </Button>
              }
            />
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {workflows.data.map((wf) => (
              <FlowCard key={wf.id} wf={wf} />
            ))}
          </div>
        )}
      </Section>

      <Section title="Templates" className="mt-10">
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {templates.isLoading &&
            Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-40" />
            ))}
          {templates.data?.map((t) => {
            const Icon = TEMPLATE_ICONS[t.icon] ?? WorkflowIcon;
            return (
              <Card key={t.key} className="group flex flex-col p-4 transition-colors hover:border-line-strong">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-line bg-sunken text-accent">
                    <Icon className="size-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-semibold tracking-tight">{t.name}</div>
                    <div className="mt-0.5 text-[11.5px] text-fg-subtle">
                      {t.stepCount} steps · {titleCase(t.category)}
                    </div>
                  </div>
                </div>
                <p className="mt-3 line-clamp-3 flex-1 text-[12.5px] leading-relaxed text-fg-muted">{t.description}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {t.providers.map((p) => (
                    <Badge key={p}>{providerName(p)}</Badge>
                  ))}
                </div>
                <div className="mt-4 flex items-center gap-2 border-t border-line pt-3">
                  <Button size="sm" variant="primary" icon={<Play className="size-3" />} onClick={() => runTemplate(t)}>
                    Run
                  </Button>
                  {can('workflow:manage') && (
                    <Button size="sm" variant="ghost" loading={clone.isPending && clone.variables?.key === t.key} onClick={() => clone.mutate(t)}>
                      Customize
                    </Button>
                  )}
                  <button
                    type="button"
                    className="ml-auto text-[11.5px] text-fg-subtle hover:text-fg"
                    onClick={() => {
                      setBuilderDraft({ name: t.name, description: t.description, definition: t.definition, readOnly: true });
                      navigate('/workflows/new?preview=1');
                    }}
                  >
                    Preview
                  </button>
                </div>
              </Card>
            );
          })}
        </div>
      </Section>
      <GenerateDialog open={generating} onClose={() => setGenerating(false)} />
    </Page>
  );
}

function FlowCard({ wf }: { wf: Workflow }) {
  const navigate = useNavigate();
  const run = useAction(() => api.post<{ id: string }>(`/workflows/${wf.id}/run`, { projectId: wf.projectId ?? undefined }), {
    success: 'Run started',
    invalidate: [['executions', 'list']],
    onSuccess: (e) => navigate(`/executions/${e.id}`),
  });
  const trigger = wf.triggers.find((t) => t.isEnabled && t.type !== 'MANUAL');
  return (
    <Card className="flex flex-col p-4 transition-colors hover:border-line-strong">
      <div className="flex items-start justify-between gap-2">
        <Link to={`/workflows/${wf.id}`} className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold tracking-tight hover:text-accent">{wf.name}</div>
          <div className="mt-0.5 text-[11.5px] text-fg-subtle">
            v{wf.version} · {wf.definition.steps.length} steps{wf.project ? ` · ${wf.project.key}` : ''}
          </div>
        </Link>
        <StatusBadge status={wf.status === 'ACTIVE' ? 'CONNECTED' : wf.status} label={titleCase(wf.status)} />
      </div>
      {wf.description && <p className="mt-2.5 line-clamp-2 text-[12.5px] text-fg-muted">{wf.description}</p>}
      <div className="mt-3 flex flex-wrap items-center gap-1.5 text-[11.5px] text-fg-muted">
        {trigger ? (
          <Badge tone="arc" icon={trigger.type === 'SCHEDULE' ? <CalendarClock className="size-3" /> : <Webhook className="size-3" />}>
            {trigger.type === 'SCHEDULE' ? String(trigger.config.cron) : String(trigger.config.event)}
          </Badge>
        ) : (
          <Badge icon={<Zap className="size-3" />}>Manual</Badge>
        )}
        <span className="ml-auto text-fg-subtle">
          {wf._count?.executions ?? 0} runs · updated {timeAgo(wf.updatedAt)}
        </span>
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
        <Button size="sm" variant="primary" icon={<Play className="size-3" />} loading={run.isPending} disabled={wf.status === 'ARCHIVED'} onClick={() => run.mutate(undefined)}>
          Run
        </Button>
        <Link to={`/workflows/${wf.id}`}>
          <Button size="sm" variant="ghost">
            Open builder
          </Button>
        </Link>
      </div>
    </Card>
  );
}

const EXAMPLES = [
  'When a Jira ticket moves to "Ready for Development": analyze it, create a branch, generate an implementation plan and notify the developer.',
  'Every weekday at 9:00 run the regression suite on staging and post a summary to the team.',
  'When a pull request is opened, review it for security issues and comment the findings.',
];

function GenerateDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const projects = useProjects();
  const [description, setDescription] = useState('');
  const [projectId, setProjectId] = useState('');
  const generate = useAction(
    () =>
      api.post<{ name: string; description: string; trigger: Record<string, unknown>; definition: FlowTemplate['definition'] | null; issues: { path: string; message: string }[] }>('/workflows/generate', {
        description,
        projectId: projectId || undefined,
      }),
    {
      onSuccess: (draft) => {
        setBuilderDraft({ name: draft.name, description: draft.description, definition: draft.definition, trigger: draft.trigger, issues: draft.issues, projectId: projectId || null });
        onClose();
        navigate('/workflows/new?draft=1');
      },
    },
  );
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Describe a flow"
      description="Forge drafts a validated flow you can review and edit in the builder before saving. Nothing runs until you say so."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" icon={<Sparkles className="size-3.5" />} loading={generate.isPending} disabled={description.trim().length < 10} onClick={() => generate.mutate(undefined)}>
            Draft flow
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="What should happen?">
          <Textarea rows={5} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={EXAMPLES[0]} autoFocus />
        </Field>
        <div className="flex flex-wrap gap-1.5">
          {EXAMPLES.map((e) => (
            <button key={e} type="button" onClick={() => setDescription(e)} className="rounded-md border border-line px-2 py-1 text-left text-[11.5px] text-fg-muted hover:border-line-strong hover:text-fg">
              {e.slice(0, 64)}…
            </button>
          ))}
        </div>
        <Field label="Project (optional)">
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            <option value="">Any project</option>
            {projects.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

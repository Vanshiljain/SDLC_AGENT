import { useState } from 'react';
import { Link } from 'react-router';
import { ExternalLink, Rocket, Undo2 } from 'lucide-react';
import { DEPLOYMENT_STATUSES } from '@forgeline/shared';
import { useDeployments, useEnvironmentBoard, useProjects } from '@/api/queries';
import type { Deployment, EnvironmentBoardItem } from '@/api/types';
import { cn } from '@/lib/cn';
import { durationBetween, formatDuration, shortSha, timeAgo, titleCase, providerName } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/form';
import { Badge, Card, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader, Section } from '@/components/ui/page';
import { StatusBadge, StatusDot } from '@/components/ui/status';
import { Pagination, Table, TableSkeleton, Td, Th, Tr } from '@/components/ui/table';
import { Sheet } from '@/components/ui/dialog';
import { commandLauncher } from '@/features/run-command';

const ENV_ORDER = { DEVELOPMENT: 0, STAGING: 1, PRODUCTION: 2 } as const;

export function DeploymentsPage() {
  useDocumentTitle('Deployments');
  usePageContext({ title: 'Deployments' });
  const board = useEnvironmentBoard();
  const projects = useProjects();
  const [projectId, setProjectId] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const history = useDeployments({ projectId: projectId || undefined, status: status || undefined, page, pageSize: 20 });
  const [open, setOpen] = useState<Deployment | null>(null);

  const byProject = new Map<string, EnvironmentBoardItem[]>();
  for (const env of board.data ?? []) byProject.set(env.project.id, [...(byProject.get(env.project.id) ?? []), env]);

  return (
    <Page wide>
      <PageHeader
        title="Deployments"
        description="What is running where. Every deployment is verified with health checks and smoke tests, and rolled back automatically if verification fails."
        actions={
          <>
            <Button icon={<Undo2 className="size-3.5" />} onClick={() => commandLauncher.open('deploy.rollback')}>
              Roll back
            </Button>
            <Button variant="primary" icon={<Rocket className="size-3.5" />} onClick={() => commandLauncher.open('deploy.environment')}>
              Deploy
            </Button>
          </>
        }
      />

      <Section title="Environments">
        {board.error ? (
          <ErrorState error={board.error} onRetry={() => void board.refetch()} />
        ) : board.isLoading ? (
          <Skeleton className="h-40" />
        ) : !byProject.size ? (
          <Card>
            <EmptyState compact icon={<Rocket />} title="No environments yet" description="Add development, staging and production environments to a project to deploy with Forgeline." action={<Link to="/projects"><Button size="sm">Open projects</Button></Link>} />
          </Card>
        ) : (
          <div className="space-y-4">
            {[...byProject.values()].map((envs) => (
              <Card key={envs[0]!.project.id} className="overflow-hidden">
                <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
                  <Link to={`/projects/${envs[0]!.project.id}`} className="text-[13px] font-semibold hover:text-accent">
                    {envs[0]!.project.name}
                  </Link>
                  <Mono>{envs[0]!.project.key}</Mono>
                </div>
                <div className="grid divide-line md:grid-cols-3 md:divide-x">
                  {[...envs].sort((a, b) => ENV_ORDER[a.type] - ENV_ORDER[b.type]).map((env) => (
                    <EnvColumn key={env.id} env={env} onOpen={setOpen} />
                  ))}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Section>

      <Section
        title="History"
        className="mt-8"
        actions={
          <div className="flex gap-2">
            <Select value={projectId} onChange={(e) => (setProjectId(e.target.value), setPage(1))} className="h-7 w-48 text-[12px]" aria-label="Project">
              <option value="">All projects</option>
              {projects.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} className="h-7 w-40 text-[12px]" aria-label="Status">
              <option value="">All statuses</option>
              {DEPLOYMENT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {titleCase(s)}
                </option>
              ))}
            </Select>
          </div>
        }
      >
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Version</Th>
                <Th>Environment</Th>
                <Th>Status</Th>
                <Th className="hidden md:table-cell">Checks</Th>
                <Th className="hidden lg:table-cell">Provider</Th>
                <Th className="text-right">When</Th>
              </tr>
            </thead>
            <tbody>
              {history.isLoading && <TableSkeleton cols={6} />}
              {history.data?.items.map((d) => {
                const checks = [...d.healthChecks, ...d.smokeTests];
                const passed = checks.filter((c) => c.status === 'passed').length;
                return (
                  <Tr key={d.id} onClick={() => setOpen(d)}>
                    <Td>
                      <div className="font-mono text-[12.5px]">{d.version}</div>
                      <div className="text-[11.5px] text-fg-subtle">
                        {d.project?.name} {d.commitSha && `· ${shortSha(d.commitSha)}`}
                      </div>
                    </Td>
                    <Td>
                      <span className="flex items-center gap-1.5">
                        {d.environment?.name}
                        {d.simulated && <Badge tone="warn">simulated</Badge>}
                      </span>
                    </Td>
                    <Td>
                      <StatusBadge status={d.status} />
                    </Td>
                    <Td className="hidden md:table-cell">
                      {checks.length ? (
                        <span className={cn('font-mono text-[12px]', passed === checks.length ? 'text-ok' : 'text-bad')}>
                          {passed}/{checks.length} passed
                        </span>
                      ) : (
                        <span className="text-fg-subtle">—</span>
                      )}
                    </Td>
                    <Td className="hidden text-fg-muted lg:table-cell">{providerName(d.provider)}</Td>
                    <Td className="text-right text-[12px] text-fg-muted">{timeAgo(d.createdAt)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
          {history.data && !history.data.items.length && <EmptyState compact icon={<Rocket />} title="No deployments match" />}
          {history.data && <Pagination page={history.data.page} pageSize={history.data.pageSize} total={history.data.total} onPage={setPage} />}
        </Card>
      </Section>
      <DeploymentSheet deployment={open} onClose={() => setOpen(null)} />
    </Page>
  );
}

function EnvColumn({ env, onOpen }: { env: EnvironmentBoardItem; onOpen: (d: Deployment) => void }) {
  const cur = env.current;
  return (
    <div className="px-4 py-3.5">
      <div className="flex items-center gap-2">
        <span className={cn('size-2 rounded-full', env.type === 'PRODUCTION' ? 'bg-accent' : env.type === 'STAGING' ? 'bg-arc' : 'bg-fg-subtle')} />
        <span className="text-[12.5px] font-semibold">{env.name}</span>
        {env.requiresApproval && <Badge tone="accent">gated</Badge>}
        {env.url && (
          <a href={env.url} target="_blank" rel="noreferrer" className="ml-auto text-fg-subtle hover:text-fg" aria-label={`Open ${env.name}`}>
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
      {cur ? (
        <button type="button" onClick={() => onOpen(cur)} className="mt-2.5 w-full rounded-md border border-line bg-sunken/50 px-3 py-2 text-left hover:border-line-strong">
          <div className="flex items-center gap-2">
            <StatusDot status={cur.status} />
            <span className="flex-1 truncate font-mono text-[12px]">{cur.version}</span>
          </div>
          <div className="mt-1 text-[11px] text-fg-subtle">
            {timeAgo(cur.completedAt ?? cur.createdAt)}
            {cur.simulated && <span className="text-warn"> · simulated</span>}
          </div>
        </button>
      ) : (
        <div className="mt-2.5 rounded-md border border-dashed border-line px-3 py-3 text-center text-[11.5px] text-fg-subtle">Nothing deployed yet</div>
      )}
      {env.recent.length > 1 && (
        <ol className="mt-2 space-y-1">
          {env.recent.slice(1, 4).map((d) => (
            <li key={d.id}>
              <button type="button" onClick={() => onOpen(d)} className="flex w-full items-center gap-2 text-left text-[11.5px] text-fg-muted hover:text-fg">
                <StatusDot status={d.status} className="size-1.5" />
                <span className="flex-1 truncate font-mono">{d.version}</span>
                <span className="text-fg-subtle">{timeAgo(d.createdAt)}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function DeploymentSheet({ deployment: d, onClose }: { deployment: Deployment | null; onClose: () => void }) {
  return (
    <Sheet open={Boolean(d)} onOpenChange={(o) => !o && onClose()} title={d ? `${d.version} → ${d.environment?.name ?? ''}` : ''} subtitle={d?.project?.name}>
      {d && (
        <div className="space-y-5 p-5">
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge status={d.status} />
            {d.simulated && <Badge tone="warn">simulated</Badge>}
            <Badge>{providerName(d.provider)}</Badge>
          </div>
          <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[12.5px]">
            <dt className="text-fg-subtle">Ref</dt>
            <dd className="font-mono">{d.ref ?? '—'}</dd>
            <dt className="text-fg-subtle">Commit</dt>
            <dd className="font-mono">{shortSha(d.commitSha)}</dd>
            <dt className="text-fg-subtle">Started</dt>
            <dd>{timeAgo(d.startedAt ?? d.createdAt)}</dd>
            <dt className="text-fg-subtle">Duration</dt>
            <dd>{formatDuration(durationBetween(d.startedAt, d.completedAt))}</dd>
            {d.externalUrl && (
              <>
                <dt className="text-fg-subtle">Provider</dt>
                <dd>
                  <a href={d.externalUrl} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                    Open ↗
                  </a>
                </dd>
              </>
            )}
            {d.executionId && (
              <>
                <dt className="text-fg-subtle">Run</dt>
                <dd>
                  <Link to={`/executions/${d.executionId}`} className="text-accent hover:underline">
                    View run →
                  </Link>
                </dd>
              </>
            )}
          </dl>
          <section>
            <h4 className="label-caps mb-2">Verification</h4>
            {[...d.healthChecks, ...d.smokeTests].length === 0 ? (
              <p className="text-[12px] text-fg-subtle">No checks recorded.</p>
            ) : (
              <ul className="divide-y divide-line rounded-md border border-line">
                {[...d.healthChecks, ...d.smokeTests].map((p) => (
                  <li key={p.name} className="flex items-center gap-2 px-3 py-2 text-[12px]">
                    <StatusDot status={p.status === 'passed' ? 'COMPLETED' : 'FAILED'} />
                    <span className="w-32 truncate font-medium">{p.name}</span>
                    <span className="flex-1 truncate text-fg-muted">{p.detail}</span>
                    <Mono>
                      {p.httpStatus ?? '—'} · {p.latencyMs ?? '—'}ms
                    </Mono>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {d.error?.message && <div className="rounded-md bg-bad-soft px-3 py-2 text-[12.5px] text-bad">{d.error.message}</div>}
        </div>
      )}
    </Sheet>
  );
}

import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Search, Zap } from 'lucide-react';
import { EXECUTION_STATUSES } from '@forgeline/shared';
import { useExecutions, useProjects } from '@/api/queries';
import { formatDuration, durationBetween, timeAgo, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/form';
import { Avatar, Card } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader } from '@/components/ui/page';
import { ForgeProgress, ModeBadge, StatusBadge } from '@/components/ui/status';
import { Pagination, Table, TableSkeleton, Td, Th, Tr } from '@/components/ui/table';
import { commandLauncher } from '@/features/run-command';

export function ExecutionsPage() {
  useDocumentTitle('Runs');
  usePageContext({ title: 'Runs' });
  const navigate = useNavigate();
  const [status, setStatus] = useState('');
  const [projectId, setProjectId] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const projects = useProjects();
  const q = { status: status || undefined, projectId: projectId || undefined, search: search.trim() || undefined, page, pageSize: 25 };
  const { data, isLoading, error, refetch } = useExecutions(q);

  return (
    <Page wide>
      <PageHeader
        title="Runs"
        description="Every flow execution — live status, approvals, artifacts and the side effects it produced."
        actions={
          <Button variant="primary" icon={<Zap className="size-3.5" />} onClick={() => commandLauncher.open('feature.deliver')}>
            Start a run
          </Button>
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-full sm:w-72">
          <Input icon={<Search className="size-3.5" />} placeholder="Search runs…" value={search} onChange={(e) => (setSearch(e.target.value), setPage(1))} />
        </div>
        <Select value={status} onChange={(e) => (setStatus(e.target.value), setPage(1))} className="w-44" aria-label="Status">
          <option value="">All statuses</option>
          {EXECUTION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
        <Select value={projectId} onChange={(e) => (setProjectId(e.target.value), setPage(1))} className="w-52" aria-label="Project">
          <option value="">All projects</option>
          {projects.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </div>
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Run</Th>
                <Th className="hidden md:table-cell">Project</Th>
                <Th>Status</Th>
                <Th className="hidden w-40 lg:table-cell">Progress</Th>
                <Th className="hidden lg:table-cell">Started by</Th>
                <Th className="text-right">Started</Th>
                <Th className="hidden text-right sm:table-cell">Duration</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton cols={7} />}
              {data?.items.map((r) => (
                <Tr key={r.id} onClick={() => navigate(`/executions/${r.id}`)}>
                  <Td>
                    <Link to={`/executions/${r.id}`} className="block max-w-[420px] truncate font-medium" onClick={(e) => e.stopPropagation()}>
                      {r.title}
                    </Link>
                    <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-fg-subtle">
                      <span className="font-mono">{r.template ?? 'custom'}</span>·<span>{titleCase(r.triggerSource)}</span>
                      <ModeBadge mode={r.mode} className="ml-1" />
                    </div>
                  </Td>
                  <Td className="hidden md:table-cell">{r.project ? <span className="text-fg-muted">{r.project.name}</span> : <span className="text-fg-subtle">—</span>}</Td>
                  <Td>
                    <StatusBadge status={r.status} />
                  </Td>
                  <Td className="hidden lg:table-cell">
                    <ForgeProgress steps={r.steps.map((s) => ({ key: s.stepKey, name: s.name, status: s.status }))} />
                  </Td>
                  <Td className="hidden lg:table-cell">
                    {r.triggeredBy ? (
                      <span className="flex items-center gap-1.5 text-fg-muted">
                        <Avatar name={r.triggeredBy.name} size={18} />
                        {r.triggeredBy.name}
                      </span>
                    ) : (
                      <span className="text-fg-subtle">System</span>
                    )}
                  </Td>
                  <Td className="text-right text-[12px] whitespace-nowrap text-fg-muted">{timeAgo(r.createdAt)}</Td>
                  <Td className="hidden text-right font-mono text-[12px] text-fg-muted sm:table-cell">{formatDuration(durationBetween(r.startedAt, r.completedAt))}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {data && !data.items.length && (
            <EmptyState
              icon={<Zap />}
              title={status || projectId || search ? 'No runs match these filters' : 'No runs yet'}
              description="Runs start from the assistant, the command palette, triggers on your flows, or webhooks."
              action={
                <Button variant="primary" onClick={() => commandLauncher.open('feature.deliver')}>
                  Deliver a feature
                </Button>
              }
            />
          )}
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </Card>
      )}
    </Page>
  );
}

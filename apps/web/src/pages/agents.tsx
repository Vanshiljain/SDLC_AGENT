import { useState } from 'react';
import { Link } from 'react-router';
import { Bot } from 'lucide-react';
import { useAgentRuns, useAgents } from '@/api/queries';
import { formatDuration, formatNumber, formatPercent, timeAgo, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Select } from '@/components/ui/form';
import { Badge, Card, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader, Section } from '@/components/ui/page';
import { StatusBadge } from '@/components/ui/status';
import { Pagination, Table, TableSkeleton, Td, Th, Tr } from '@/components/ui/table';
import { agentOf } from '@/features/flow-graph';

export function AgentsPage() {
  useDocumentTitle('Agents');
  usePageContext({ title: 'Agents' });
  const agents = useAgents();
  const [agent, setAgent] = useState('');
  const [page, setPage] = useState(1);
  const runs = useAgentRuns({ agent: agent || undefined, page, pageSize: 25 });
  return (
    <Page wide>
      <PageHeader title="Agents" description="Specialised agents that plan, build, review, test, release and document. Each acts only through registered tools, with your permissions, under your approval policy." />
      {agents.error ? (
        <ErrorState error={agents.error} />
      ) : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {agents.isLoading && Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-44" />)}
          {agents.data?.map((a) => {
            const v = agentOf({ agent: a.key });
            return (
              <Card key={a.id} className="flex flex-col p-4">
                <div className="flex items-start gap-3">
                  <span className="flex size-9 items-center justify-center rounded-lg" style={{ background: `color-mix(in oklab, ${v.color} 15%, transparent)`, color: v.color }}>
                    <v.icon className="size-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-[13.5px] font-semibold tracking-tight">{a.name}</div>
                    <div className="text-[11px] text-fg-subtle">
                      {titleCase(a.kind)} · model role <Mono className="text-[10.5px]">{a.modelRole}</Mono>
                    </div>
                  </div>
                  {a.active.length > 0 && <Badge tone="arc">{a.active.length} active</Badge>}
                </div>
                <p className="mt-3 flex-1 text-[12px] text-fg-muted">{a.description}</p>
                <div className="mt-3 flex flex-wrap gap-1">
                  {a.tools.slice(0, 4).map((t) => (
                    <Badge key={t} className="font-mono text-[10px]">
                      {t}
                    </Badge>
                  ))}
                  {a.tools.length > 4 && <Badge>+{a.tools.length - 4}</Badge>}
                </div>
                <div className="mt-3 grid grid-cols-3 border-t border-line pt-3 text-[11px]">
                  <div>
                    <div className="text-fg-subtle">Runs · 30d</div>
                    <div className="font-mono text-[13px]">{a.stats30d.runs}</div>
                  </div>
                  <div>
                    <div className="text-fg-subtle">Success</div>
                    <div className="font-mono text-[13px]">{formatPercent(a.stats30d.successRate)}</div>
                  </div>
                  <div>
                    <div className="text-fg-subtle">Tokens</div>
                    <div className="font-mono text-[13px]">{formatNumber(a.stats30d.tokens)}</div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}
      <Section
        title="Activity"
        className="mt-8"
        actions={
          <Select value={agent} onChange={(e) => (setAgent(e.target.value), setPage(1))} className="h-7 w-48 text-[12px]" aria-label="Agent">
            <option value="">All agents</option>
            {agents.data?.map((a) => (
              <option key={a.key} value={a.key}>
                {a.name}
              </option>
            ))}
          </Select>
        }
      >
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Agent</Th>
                <Th>Task</Th>
                <Th>Status</Th>
                <Th className="hidden lg:table-cell">Model</Th>
                <Th className="hidden text-right md:table-cell">Tokens</Th>
                <Th className="hidden text-right md:table-cell">Duration</Th>
                <Th className="text-right">When</Th>
              </tr>
            </thead>
            <tbody>
              {runs.isLoading && <TableSkeleton cols={7} />}
              {runs.data?.items.map((r) => {
                const v = agentOf({ agent: r.agent?.key });
                return (
                  <Tr key={r.id}>
                    <Td>
                      <span className="flex items-center gap-2 whitespace-nowrap">
                        <v.icon className="size-3.5" style={{ color: v.color }} />
                        {r.agent?.name}
                      </span>
                    </Td>
                    <Td>
                      <div className="max-w-[420px] truncate">{r.summary ?? r.task}</div>
                      {r.executionId && (
                        <Link to={`/executions/${r.executionId}`} className="text-[11.5px] text-fg-subtle hover:text-accent">
                          View run →
                        </Link>
                      )}
                    </Td>
                    <Td>
                      <StatusBadge status={r.status} />
                    </Td>
                    <Td className="hidden lg:table-cell">
                      <Mono>{r.model ?? '—'}</Mono>
                    </Td>
                    <Td className="hidden text-right font-mono text-[12px] md:table-cell">{formatNumber(r.totalTokens)}</Td>
                    <Td className="hidden text-right font-mono text-[12px] md:table-cell">{formatDuration(r.durationMs)}</Td>
                    <Td className="text-right text-[12px] text-fg-muted">{timeAgo(r.startedAt)}</Td>
                  </Tr>
                );
              })}
            </tbody>
          </Table>
          {runs.data && !runs.data.items.length && <EmptyState compact icon={<Bot />} title="No agent activity yet" />}
          {runs.data && <Pagination page={runs.data.page} pageSize={runs.data.pageSize} total={runs.data.total} onPage={setPage} />}
        </Card>
      </Section>
    </Page>
  );
}

import { Activity, Coins, Gauge, TriangleAlert } from 'lucide-react';
import { useObservability } from '@/api/queries';
import { formatDuration, formatNumber, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { BarList, StackedBars } from '@/components/ui/charts';
import { Card, CardHeader, Mono, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader, Stat } from '@/components/ui/page';
import { Table, Td, Th, Tr } from '@/components/ui/table';

const STATUS_COLORS: Record<string, string> = { COMPLETED: 'var(--color-ok)', FAILED: 'var(--color-bad)', CANCELLED: 'var(--color-fg-subtle)', COMPENSATED: 'var(--color-warn)', RUNNING: 'var(--color-arc)', WAITING_APPROVAL: 'var(--color-accent)' };

export function ObservabilityPage() {
  useDocumentTitle('Observability');
  usePageContext({ title: 'Observability' });
  const { data, isLoading, error, refetch } = useObservability();
  if (error) return <Page><ErrorState error={error} onRetry={() => void refetch()} /></Page>;
  if (isLoading || !data) return <Page><Skeleton className="h-96" /></Page>;

  const days: string[] = [];
  for (let i = data.windowDays - 1; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const statuses = [...new Set(data.runsDaily.map((r) => r.status))];
  const series = statuses.map((s) => ({ key: s, color: STATUS_COLORS[s] ?? 'var(--color-line-strong)', values: days.map((d) => data.runsDaily.filter((r) => r.day.slice(0, 10) === d && r.status === s).reduce((a, r) => a + r.count, 0)) }));
  const totalRuns = data.runsDaily.reduce((a, r) => a + r.count, 0);
  const failedRuns = data.runsDaily.filter((r) => r.status === 'FAILED').reduce((a, r) => a + r.count, 0);
  const tokens = data.tokensByModel.reduce((a, r) => a + r.total, 0);
  const toolCalls = data.tools.reduce((a, t) => a + t.total, 0);
  const toolFailures = data.tools.reduce((a, t) => a + t.failed, 0);

  return (
    <Page wide>
      <PageHeader title="Observability" description={`Runs, agents, tools and LLM usage over the last ${data.windowDays} days. Prometheus metrics are exported at /metrics for your own dashboards.`} />
      <Card className="mb-6 grid grid-cols-2 divide-line lg:grid-cols-4 lg:divide-x [&>*]:border-line max-lg:[&>*]:border-b">
        <Stat icon={<Activity />} label="Runs" value={formatNumber(totalRuns)} hint={`${failedRuns} failed`} />
        <Stat icon={<Gauge />} label="Tool calls" value={formatNumber(toolCalls)} hint={`${toolFailures} failed`} />
        <Stat icon={<Coins />} label="LLM tokens" value={formatNumber(tokens)} hint={`${data.tokensByModel.reduce((a, r) => a + r.calls, 0)} calls`} />
        <Stat icon={<TriangleAlert />} label="Error kinds" value={data.errorKinds.length} hint={data.errorKinds[0] ? `${titleCase(data.errorKinds[0].kind)} most common` : 'none'} />
      </Card>
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Runs per day" description={statuses.map((s) => titleCase(s)).join(' · ') || undefined} />
          <div className="px-4 pb-4">{totalRuns ? <StackedBars days={days} series={series} /> : <EmptyState compact title="No runs in this window" />}</div>
        </Card>
        <Card>
          <CardHeader title="Tokens by model" />
          <div className="px-4 pb-4">{data.tokensByModel.length ? <BarList items={data.tokensByModel.map((m) => ({ label: m.model, value: m.total, hint: `${m.calls} calls · ${formatNumber(m.prompt)} in / ${formatNumber(m.completion)} out` }))} format={formatNumber} color="var(--color-ai)" /> : <EmptyState compact title="No LLM usage recorded" />}</div>
        </Card>
        <Card>
          <CardHeader title="Agents" />
          <div className="px-4 pb-4">
            {data.agents.length ? <BarList items={data.agents.map((a) => ({ label: a.agent, value: a.runs, hint: `${a.failed} failed · ${formatNumber(a.tokens)} tok · avg ${formatDuration(a.avgMs)}` }))} /> : <EmptyState compact title="No agent runs" />}
          </div>
        </Card>
        <Card>
          <CardHeader title="Step latency (p50 / p95)" />
          <div className="px-4 pb-4">{data.stepLatency.length ? <BarList items={data.stepLatency.slice(0, 10).map((s) => ({ label: s.tool, value: s.p95 ?? 0, hint: `p50 ${formatDuration(s.p50)} · n=${s.samples}` }))} format={(n) => formatDuration(n)} color="var(--color-arc)" /> : <EmptyState compact title="No step timings" />}</div>
        </Card>
      </div>
      <Card className="mt-5">
        <CardHeader title="Tools" description="Calls, failures and latency per tool (from the tool execution ledger)." />
        <Table>
          <thead>
            <tr>
              <Th>Tool</Th>
              <Th className="text-right">Calls</Th>
              <Th className="text-right">Failed</Th>
              <Th className="text-right">Error rate</Th>
              <Th className="text-right">Avg</Th>
              <Th className="text-right">p95</Th>
            </tr>
          </thead>
          <tbody>
            {data.tools.map((t) => (
              <Tr key={t.tool}>
                <Td>
                  <Mono className="text-fg">{t.tool}</Mono>
                </Td>
                <Td className="text-right font-mono text-[12px]">{t.total}</Td>
                <Td className="text-right font-mono text-[12px]">{t.failed}</Td>
                <Td className={`text-right font-mono text-[12px] ${t.errorRate > 0.1 ? 'text-bad' : ''}`}>{(t.errorRate * 100).toFixed(1)}%</Td>
                <Td className="text-right font-mono text-[12px]">{formatDuration(t.avgMs)}</Td>
                <Td className="text-right font-mono text-[12px]">{formatDuration(t.p95Ms)}</Td>
              </Tr>
            ))}
          </tbody>
        </Table>
      </Card>
    </Page>
  );
}

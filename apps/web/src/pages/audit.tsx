import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Download, ScrollText, Search } from 'lucide-react';
import { AUDIT_STATUSES } from '@forgeline/shared';
import { useAudit, useMembers } from '@/api/queries';
import type { AuditEntry } from '@/api/types';
import { formatDateTime, titleCase } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { JsonView } from '@/components/ui/content';
import { Sheet } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/form';
import { Avatar, Badge, Card, Mono } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader } from '@/components/ui/page';
import { Pagination, Table, TableSkeleton, Td, Th, Tr } from '@/components/ui/table';

const STATUS_TONE = { SUCCESS: 'ok', FAILURE: 'bad', DENIED: 'accent' } as const;

function toCsv(rows: AuditEntry[]): string {
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const header = ['time', 'actor', 'actorType', 'action', 'resourceType', 'resourceId', 'status', 'executionId', 'tool', 'ip', 'requestId'];
  return [
    header.join(','),
    ...rows.map((r) =>
      [
        r.createdAt,
        r.actor?.email ?? r.actorLabel ?? '',
        r.actorType,
        r.action,
        r.resourceType,
        r.resourceId,
        r.status,
        r.executionId,
        r.tool,
        r.ip,
        r.requestId,
      ]
        .map(esc)
        .join(','),
    ),
  ].join('\n');
}

export function AuditPage() {
  useDocumentTitle('Audit log');
  usePageContext({ title: 'Audit log' });
  const [params] = useSearchParams();
  const members = useMembers();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState('');
  const [actorId, setActorId] = useState('');
  const [resourceType, setResourceType] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [page, setPage] = useState(1);
  const executionId = params.get('executionId') ?? undefined;
  const { data, isLoading, error } = useAudit({
    search: search || undefined,
    status: status || undefined,
    actorId: actorId || undefined,
    resourceType: resourceType || undefined,
    executionId,
    from: from || undefined,
    to: to ? `${to}T23:59:59Z` : undefined,
    page,
    pageSize: 50,
  });
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const reset = () => setPage(1);

  const download = () => {
    if (!data) return;
    const blob = new Blob([toCsv(data.items)], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `forgeline-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Page wide>
      <PageHeader
        title="Audit log"
        description="Every privileged action by people, agents and the system — including denied attempts. Secrets are redacted before they are recorded."
        actions={
          <Button icon={<Download className="size-3.5" />} onClick={download} disabled={!data?.items.length}>
            Export page (CSV)
          </Button>
        }
      />
      {executionId && (
        <div className="mb-3 flex items-center gap-2 text-[12.5px] text-fg-muted">
          Filtered to run <Mono>{executionId.slice(0, 8)}</Mono> ·{' '}
          <Link to="/audit-logs" className="text-accent hover:underline">
            clear
          </Link>
        </div>
      )}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="w-64">
          <Input
            icon={<Search className="size-3.5" />}
            placeholder="Search actions, resources…"
            value={search}
            onChange={(e) => (setSearch(e.target.value), reset())}
          />
        </div>
        <Select value={actorId} onChange={(e) => (setActorId(e.target.value), reset())} className="w-44" aria-label="Actor">
          <option value="">Anyone</option>
          {members.data?.members.map((m) => (
            <option key={m.user.id} value={m.user.id}>
              {m.user.name}
            </option>
          ))}
        </Select>
        <Select value={status} onChange={(e) => (setStatus(e.target.value), reset())} className="w-36" aria-label="Status">
          <option value="">Any outcome</option>
          {AUDIT_STATUSES.map((s) => (
            <option key={s} value={s}>
              {titleCase(s)}
            </option>
          ))}
        </Select>
        <Select value={resourceType} onChange={(e) => (setResourceType(e.target.value), reset())} className="w-40" aria-label="Resource">
          <option value="">Any resource</option>
          {[
            'execution',
            'workflow_execution',
            'approval',
            'integration',
            'project',
            'workflow',
            'tool',
            'user',
            'organization',
            'knowledge_document',
          ].map((r) => (
            <option key={r} value={r}>
              {titleCase(r)}
            </option>
          ))}
        </Select>
        <Input type="date" value={from} onChange={(e) => (setFrom(e.target.value), reset())} className="w-36" aria-label="From" />
        <Input type="date" value={to} onChange={(e) => (setTo(e.target.value), reset())} className="w-36" aria-label="To" />
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : (
        <Card>
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Actor</Th>
                <Th>Action</Th>
                <Th className="hidden md:table-cell">Resource</Th>
                <Th>Outcome</Th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <TableSkeleton cols={5} rows={10} />}
              {data?.items.map((e) => (
                <Tr key={e.id} onClick={() => setOpen(e)}>
                  <Td className="font-mono text-[11.5px] whitespace-nowrap text-fg-muted">{formatDateTime(e.createdAt)}</Td>
                  <Td>
                    <span className="flex items-center gap-1.5 whitespace-nowrap">
                      {e.actor ? <Avatar name={e.actor.name} size={18} /> : null}
                      {e.actor?.name ?? e.actorLabel ?? titleCase(e.actorType)}
                      {e.actorType !== 'USER' && (
                        <Badge tone={e.actorType === 'AGENT' ? 'ai' : 'neutral'}>{e.actorType.toLowerCase()}</Badge>
                      )}
                    </span>
                  </Td>
                  <Td>
                    <Mono className="text-fg">{e.action}</Mono>
                    {e.tool && <div className="text-[11px] text-fg-subtle">{e.tool}</div>}
                  </Td>
                  <Td className="hidden md:table-cell">
                    <span className="text-fg-muted">{titleCase(e.resourceType)}</span>{' '}
                    {e.resourceId && <Mono>{e.resourceId.slice(0, 8)}</Mono>}
                  </Td>
                  <Td>
                    <Badge tone={STATUS_TONE[e.status] ?? 'neutral'}>{titleCase(e.status)}</Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
          {data && !data.items.length && <EmptyState compact icon={<ScrollText />} title="No matching entries" />}
          {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
        </Card>
      )}
      <Sheet
        open={Boolean(open)}
        onOpenChange={(o) => !o && setOpen(null)}
        title={open?.action ?? ''}
        subtitle={open ? formatDateTime(open.createdAt) : undefined}
      >
        {open && (
          <div className="space-y-4 p-5">
            <dl className="grid grid-cols-[120px_1fr] gap-y-2 text-[12.5px]">
              <dt className="text-fg-subtle">Actor</dt>
              <dd>
                {open.actor?.name ?? open.actorLabel ?? '—'} <span className="text-fg-subtle">({open.actorType.toLowerCase()})</span>
              </dd>
              <dt className="text-fg-subtle">Outcome</dt>
              <dd>
                <Badge tone={STATUS_TONE[open.status] ?? 'neutral'}>{titleCase(open.status)}</Badge>
              </dd>
              <dt className="text-fg-subtle">Resource</dt>
              <dd>
                {titleCase(open.resourceType)} <Mono>{open.resourceId}</Mono>
              </dd>
              {open.executionId && (
                <>
                  <dt className="text-fg-subtle">Run</dt>
                  <dd>
                    <Link to={`/executions/${open.executionId}`} className="text-accent hover:underline">
                      Open run →
                    </Link>
                  </dd>
                </>
              )}
              <dt className="text-fg-subtle">IP</dt>
              <dd>
                <Mono>{open.ip ?? '—'}</Mono>
              </dd>
              <dt className="text-fg-subtle">Request</dt>
              <dd>
                <Mono>{open.requestId ?? '—'}</Mono>
              </dd>
            </dl>
            {open.input != null && (
              <div>
                <div className="label-caps mb-1.5">Input</div>
                <JsonView value={open.input} />
              </div>
            )}
            {open.output != null && (
              <div>
                <div className="label-caps mb-1.5">Output</div>
                <JsonView value={open.output} />
              </div>
            )}
          </div>
        )}
      </Sheet>
    </Page>
  );
}

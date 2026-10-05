import { useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Hand, Inbox, Lock } from 'lucide-react';
import { useApprovals } from '@/api/queries';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Card, Skeleton } from '@/components/ui/primitives';
import { EmptyState, ErrorState, Page, PageHeader } from '@/components/ui/page';
import { ModeBadge, RiskBadge, StatusBadge } from '@/components/ui/status';
import { Segmented } from '@/components/ui/tabs';
import { Pagination } from '@/components/ui/table';
import { Sheet } from '@/components/ui/dialog';
import { ApprovalReview } from '@/features/approval-review';
import { useMediaQuery } from '@/lib/use-media';

type Filter = 'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL';

export function ApprovalsPage() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [filter, setFilter] = useState<Filter>('PENDING');
  const [page, setPage] = useState(1);
  const { data, isLoading, error, refetch } = useApprovals({ status: filter === 'ALL' ? undefined : filter, page, pageSize: 25 });
  useDocumentTitle('Approvals');
  usePageContext(id ? { title: 'Approval', entity: { kind: 'approval', id } } : { title: 'Approvals' }, [id]);
  const items = data?.items ?? [];
  const desktop = useMediaQuery('(min-width: 1024px)');
  const open = (approvalId: string) => navigate(`/approvals/${approvalId}`);

  return (
    <Page wide>
      <PageHeader
        title="Approvals"
        description="Human-in-the-loop gates for production deploys, merges and other risky actions. Policy is enforced by the server at execution time."
        actions={
          <Segmented
            value={filter}
            onChange={(v) => (setFilter(v), setPage(1))}
            options={[
              { value: 'PENDING', label: 'Pending' },
              { value: 'APPROVED', label: 'Approved' },
              { value: 'REJECTED', label: 'Rejected' },
              { value: 'ALL', label: 'All' },
            ]}
          />
        }
      />
      {error ? (
        <ErrorState error={error} onRetry={() => void refetch()} />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,420px)_minmax(0,1fr)]">
          <Card className="self-start overflow-hidden">
            {isLoading && (
              <div className="space-y-2 p-3">
                {Array.from({ length: 4 }, (_, i) => (
                  <Skeleton key={i} className="h-16" />
                ))}
              </div>
            )}
            {!isLoading && !items.length && (
              <EmptyState
                compact
                icon={<Inbox />}
                title={filter === 'PENDING' ? 'Nothing waiting on you' : 'No approvals'}
                description={filter === 'PENDING' ? 'When a run reaches a gate, it shows up here and in your notifications.' : undefined}
              />
            )}
            <ul className="divide-y divide-line">
              {items.map((a) => (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => open(a.id)}
                    className={cn('block w-full px-4 py-3 text-left transition-colors hover:bg-sunken/60', a.id === id && 'bg-sunken')}
                  >
                    <div className="flex items-center gap-2">
                      <Hand className={cn('size-3.5 shrink-0', a.status === 'PENDING' ? 'text-accent' : 'text-fg-subtle')} />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.title}</span>
                      {a.status === 'PENDING' ? <RiskBadge level={a.riskLevel} /> : <StatusBadge status={a.status} />}
                    </div>
                    <div className="mt-1 truncate pl-5.5 text-[11.5px] text-fg-subtle">{a.execution?.title}</div>
                    <div className="mt-1.5 flex items-center gap-2 pl-5.5 text-[11px] text-fg-subtle">
                      <span className="font-mono">{a.action}</span>
                      {a.execution && <ModeBadge mode={a.execution.mode} />}
                      <span className="ml-auto">{timeAgo(a.createdAt)}</span>
                      {a.status === 'PENDING' && !a.canDecide && (
                        <span title="You can’t decide this one">
                          <Lock className="size-3" />
                        </span>
                      )}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
            {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
          </Card>
          <Card className="hidden min-h-[560px] overflow-hidden lg:block">
            {id ? (
              <ApprovalReview key={id} approvalId={id} onDecided={() => void refetch()} />
            ) : (
              <EmptyState
                icon={<Hand />}
                title="Select an approval"
                description="Review the evidence and risk assessment, then approve or reject. Every decision is audited."
              />
            )}
          </Card>
        </div>
      )}
      {!desktop && (
        <Sheet open={Boolean(id)} onOpenChange={(o) => !o && navigate('/approvals')} title="Approval" width={640}>
          {id && <ApprovalReview approvalId={id} onDecided={() => void refetch()} />}
        </Sheet>
      )}
    </Page>
  );
}

import type { QueryClient } from '@tanstack/react-query';
import { realtime, type RealtimeEvent } from '@/lib/realtime';
import { qk } from './queries';

/**
 * Maps realtime domain events to cache invalidations so every view stays live
 * without polling. Invalidation is coalesced per animation frame.
 */
export function bindLiveCache(qc: QueryClient): () => void {
  const pending = new Set<string>();
  let scheduled = false;
  const invalidate = (key: readonly unknown[]) => {
    pending.add(JSON.stringify(key));
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      for (const k of pending) void qc.invalidateQueries({ queryKey: JSON.parse(k) as unknown[] });
      pending.clear();
    }, 120);
  };

  const handle = (e: RealtimeEvent) => {
    const t = e.type;
    if (t.startsWith('workflow.')) {
      if (e.executionId) invalidate(qk.execution(e.executionId));
      if (t !== 'workflow.log' && t !== 'workflow.step.progress') {
        invalidate(['executions', 'list']);
        invalidate(qk.dashboard);
      }
    }
    if (t.startsWith('approval.')) {
      invalidate(['approvals']);
      invalidate(qk.dashboard);
      if (e.executionId) invalidate(qk.execution(e.executionId));
    }
    if (t.startsWith('deployment.')) {
      invalidate(['deployments']);
      invalidate(qk.dashboard);
      invalidate(qk.projects);
    }
    if (t === 'code.reviewed') invalidate(['code-review']);
    if (t === 'code.generated') invalidate(['code-generation']);
    if (t.startsWith('qa.')) invalidate(['qa']);
    if (t === 'notification.created') {
      invalidate(qk.notifications);
      invalidate(qk.unread);
    }
    if (t === 'integration.status') invalidate(qk.integrations);
    if (t === 'knowledge.document.status') invalidate(['knowledge']);
    if (t === 'agent.activity') {
      invalidate(qk.agents);
      invalidate(['agents', 'runs']);
    }
    if (t === 'agent.message.completed' && e.conversationId) {
      invalidate(qk.conversation(e.conversationId));
      invalidate(qk.conversations);
    }
  };
  return realtime.on(handle);
}

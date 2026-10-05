import { useNavigate, useParams } from 'react-router';
import { MessageSquareText, Plus } from 'lucide-react';
import { useConversations } from '@/api/queries';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import { useUi } from '@/lib/ui-store';
import { useDocumentTitle, usePageContext } from '@/lib/use-page-context';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/primitives';
import { ChatThread } from '@/features/assistant/chat-thread';

export function ChatPage() {
  const { conversationId = null } = useParams();
  const navigate = useNavigate();
  const conversations = useConversations();
  const draft = useUi((s) => (s.assistantOpen ? null : s.assistantDraft));
  const active = conversations.data?.find((c) => c.id === conversationId);
  useDocumentTitle(active?.title ?? 'Assistant');
  usePageContext({ title: 'Assistant' });

  return (
    <div className="flex h-full min-h-0">
      <aside className="hidden w-[264px] shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-12 items-center justify-between border-b border-line px-3">
          <span className="text-[13px] font-semibold">Conversations</span>
          <Button size="xs" variant="secondary" icon={<Plus className="size-3" />} onClick={() => navigate('/chat')}>
            New
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-2">
          {conversations.isLoading &&
            Array.from({ length: 5 }, (_, i) => <Skeleton key={i} className="mb-1.5 h-10" />)}
          {!conversations.isLoading && !conversations.data?.length && <p className="px-2 py-6 text-center text-[12px] text-fg-subtle">Your conversations with Forge appear here.</p>}
          {conversations.data?.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => navigate(`/chat/${c.id}`)}
              className={cn('mb-0.5 flex w-full items-start gap-2 rounded-md px-2.5 py-2 text-left transition-colors', c.id === conversationId ? 'bg-sunken' : 'hover:bg-sunken/60')}
            >
              <MessageSquareText className="mt-0.5 size-3.5 shrink-0 text-fg-subtle" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium">{c.title}</span>
                <span className="block text-[11px] text-fg-subtle">
                  {c.project?.key ? `${c.project.key} · ` : ''}
                  {timeAgo(c.updatedAt)}
                </span>
              </span>
            </button>
          ))}
        </div>
      </aside>
      <div className="min-w-0 flex-1">
        <ChatThread conversationId={conversationId} onConversation={(id) => navigate(`/chat/${id}`, { replace: true })} draft={draft} />
      </div>
    </div>
  );
}

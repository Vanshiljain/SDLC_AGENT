import { History, Maximize2, Plus, X } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useConversations } from '@/api/queries';
import { timeAgo } from '@/lib/format';
import { ui, useUi } from '@/lib/ui-store';
import { Button } from '@/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger, Tooltip } from '@/components/ui/menu';
import { ChatThread } from './chat-thread';

/** The global assistant: available on every page, aware of what the user is viewing. */
export function AssistantPanel() {
  const conversationId = useUi((s) => s.assistantConversationId);
  const pageContext = useUi((s) => s.pageContext);
  const draft = useUi((s) => s.assistantDraft);
  const conversations = useConversations();
  const navigate = useNavigate();

  return (
    <aside
      className="fixed inset-0 z-40 flex flex-col border-l border-line bg-surface sm:static sm:z-auto sm:w-[420px] sm:shrink-0 xl:w-[460px]"
      aria-label="Forge assistant"
    >
      <div className="flex h-11 shrink-0 items-center gap-1 border-b border-line px-3">
        <span className="text-[13px] font-semibold">Forge</span>
        <span className="ml-1 truncate text-[11.5px] text-fg-subtle">{pageContext?.entity?.label ?? ''}</span>
        <div className="ml-auto flex items-center gap-0.5">
          <Menu>
            <Tooltip content="Recent conversations">
              <MenuTrigger asChild>
                <Button size="icon-sm" variant="ghost" aria-label="Recent conversations" icon={<History className="size-4" />} />
              </MenuTrigger>
            </Tooltip>
            <MenuContent className="w-72">
              <MenuLabel>Recent</MenuLabel>
              {(conversations.data ?? []).slice(0, 12).map((c) => (
                <MenuItem key={c.id} onSelect={() => ui.set({ assistantConversationId: c.id })}>
                  <span className="flex-1 truncate">{c.title}</span>
                  <span className="text-[11px] text-fg-subtle">{timeAgo(c.updatedAt)}</span>
                </MenuItem>
              ))}
              {!conversations.data?.length && <div className="px-2 py-3 text-[12px] text-fg-subtle">No conversations yet.</div>}
            </MenuContent>
          </Menu>
          <Tooltip content="New conversation">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="New conversation"
              onClick={() => ui.set({ assistantConversationId: null })}
              icon={<Plus className="size-4" />}
            />
          </Tooltip>
          <Tooltip content="Open full view">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Open full view"
              onClick={() => {
                ui.set({ assistantOpen: false });
                navigate(conversationId ? `/chat/${conversationId}` : '/chat');
              }}
              icon={<Maximize2 className="size-3.5" />}
            />
          </Tooltip>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Close assistant"
            onClick={() => ui.set({ assistantOpen: false })}
            icon={<X className="size-4" />}
          />
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <ChatThread
          compact
          conversationId={conversationId}
          onConversation={(id) => ui.set({ assistantConversationId: id })}
          pageContext={pageContext}
          projectId={pageContext?.projectId}
          draft={draft}
        />
      </div>
    </aside>
  );
}

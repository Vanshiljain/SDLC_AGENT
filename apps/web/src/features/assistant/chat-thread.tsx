import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowUp, Sparkles, Square } from 'lucide-react';
import { toast } from 'sonner';
import type { PageContext } from '@forgeline/shared';
import { errorMessage } from '@/api/client';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/cn';
import { timeAgo } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { MarkdownView } from '@/components/ui/content';
import { Avatar, Spinner } from '@/components/ui/primitives';
import { MessageParts, ToolCalls } from './message-parts';
import { useChat } from './use-chat';

const SUGGESTIONS = [
  'Implement a password reset feature for my authentication service',
  'Review the latest pull request for security issues',
  'Deploy the authentication service to staging',
  'What failed in my most recent run, and why?',
];

export function ChatThread({
  conversationId,
  onConversation,
  pageContext,
  projectId,
  compact,
  draft,
}: {
  conversationId: string | null;
  onConversation: (id: string) => void;
  pageContext?: PageContext | null;
  projectId?: string | null;
  compact?: boolean;
  draft?: { text: string; send: boolean; nonce: number } | null;
}) {
  const { user } = useAuth();
  const { messages, streams, send, cancel, responding, conversation } = useChat(conversationId);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const lastNonce = useRef<number | null>(null);

  const submit = async (value = text) => {
    const content = value.trim();
    if (!content || sending || responding) return;
    setSending(true);
    try {
      const id = await send(content, { pageContext, projectId });
      setText('');
      if (id !== conversationId) onConversation(id);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSending(false);
    }
  };

  // Prompts handed over from ⌘K / Command Center.
  useEffect(() => {
    if (!draft || draft.nonce === lastNonce.current) return;
    lastNonce.current = draft.nonce;
    if (draft.send) void submit(draft.text);
    else {
      setText(draft.text);
      input.current?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const streamKey = Object.values(streams)
    .map((s) => s.text.length + s.tools.length)
    .join(',');
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, streamKey]);

  useLayoutEffect(() => {
    const el = input.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const empty = !messages.length && !conversation.isLoading;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        {empty ? (
          <div className={cn('mx-auto flex h-full max-w-xl flex-col justify-center', compact ? 'px-4' : 'px-6')}>
            <div className="mb-4 flex size-10 items-center justify-center rounded-xl bg-ai-soft text-ai">
              <Sparkles className="size-5" />
            </div>
            <h2 className="text-[17px] font-semibold tracking-tight">What should we ship?</h2>
            <p className="mt-1 text-[13px] text-fg-muted">Describe a feature, fix or release. Forge plans it as a flow, shows the approvals it needs, and runs it with you in the loop.</p>
            <div className="mt-5 grid gap-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => void submit(s)} className="rounded-md border border-line bg-raised px-3 py-2 text-left text-[12.5px] text-fg-muted transition-colors hover:border-ai/40 hover:text-fg">
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className={cn('mx-auto max-w-3xl space-y-6 py-5', compact ? 'px-4' : 'px-6')}>
            {conversation.isLoading && (
              <div className="flex justify-center py-10">
                <Spinner className="text-fg-subtle" />
              </div>
            )}
            {messages.map((m) => {
              if (m.role === 'USER') {
                return (
                  <div key={m.id} className="flex justify-end gap-2.5">
                    <div className="max-w-[85%] rounded-xl rounded-tr-sm bg-sunken px-3.5 py-2 text-[13.5px] leading-6 whitespace-pre-wrap">{m.content}</div>
                    {!compact && <Avatar name={user?.name} size={26} />}
                  </div>
                );
              }
              const live = streams[m.id];
              return (
                <div key={m.id} className="flex gap-2.5">
                  <span className="mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-full bg-ai-soft text-ai">
                    <Sparkles className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex items-center gap-2 text-[11.5px] text-fg-subtle">
                      <span className="font-medium text-fg-muted">Forge</span>
                      <span>{timeAgo(m.createdAt)}</span>
                    </div>
                    {m.status === 'streaming' ? (
                      <div className="space-y-2">
                        {live?.tools.length ? <ToolCalls tools={live.tools} /> : null}
                        {live?.text ? (
                          <MarkdownView>{live.text}</MarkdownView>
                        ) : (
                          <div className="flex items-center gap-2 text-[12.5px] text-fg-subtle">
                            <span className="h-1 w-10 rounded-full forge-line" /> Thinking…
                          </div>
                        )}
                      </div>
                    ) : (
                      <MessageParts message={m} conversationId={m.conversationId} compact={compact} />
                    )}
                    {m.status === 'cancelled' && <div className="text-[11.5px] text-fg-subtle">Stopped.</div>}
                    {m.status === 'interrupted' && <div className="text-[11.5px] text-warn">This response was interrupted.</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
      <div className={cn('border-t border-line bg-surface', compact ? 'p-3' : 'px-6 py-4')}>
        <form
          className="mx-auto max-w-3xl"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="flex items-end gap-2 rounded-lg border border-line bg-raised p-1.5 pl-3 transition-colors focus-within:border-ai/50 focus-within:ring-2 focus-within:ring-ai/15">
            <textarea
              ref={input}
              value={text}
              rows={1}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder={responding ? 'Forge is responding…' : 'Ask Forge to plan, build, review or ship…'}
              aria-label="Message Forge"
              className="max-h-[200px] min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[13.5px] leading-5 outline-none placeholder:text-fg-subtle"
            />
            {responding ? (
              <Button size="icon-sm" variant="secondary" aria-label="Stop response" onClick={() => void cancel()} icon={<Square className="size-3 fill-current" />} />
            ) : (
              <Button type="submit" size="icon-sm" variant="primary" aria-label="Send" loading={sending} disabled={!text.trim()} icon={<ArrowUp className="size-4" />} />
            )}
          </div>
          {pageContext?.entity && (
            <div className="mt-1.5 px-1 text-[11px] text-fg-subtle">
              Context: <span className="text-fg-muted">{pageContext.entity.label ?? pageContext.entity.kind}</span>
            </div>
          )}
        </form>
      </div>
    </div>
  );
}

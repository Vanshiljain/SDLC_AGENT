import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { PageContext, ToolCallPart } from '@forgeline/shared';
import { api } from '@/api/client';
import { qk } from '@/api/queries';
import type { Conversation, ConversationDetail, Message } from '@/api/types';
import { realtime } from '@/lib/realtime';

export interface LiveStream {
  text: string;
  tools: ToolCallPart[];
}

/**
 * Conversation state with token streaming. The server persists messages; the
 * socket delivers deltas and tool activity for the in-flight assistant message.
 * While a message is still streaming, the conversation is also refetched as a
 * fallback in case realtime delivery was missed.
 */
export function useChat(conversationId: string | null) {
  const qc = useQueryClient();
  const [streams, setStreams] = useState<Record<string, LiveStream>>({});
  const idRef = useRef(conversationId);
  idRef.current = conversationId;

  const conversation = useQuery<ConversationDetail>({
    queryKey: qk.conversation(conversationId ?? 'none'),
    queryFn: ({ signal }) => api.get<ConversationDetail>(`/conversations/${conversationId}`, undefined, signal),
    enabled: Boolean(conversationId),
    refetchInterval: (q) => (q.state.data?.messages.some((m) => m.status === 'streaming') ? 2500 : false),
  });

  useEffect(() => {
    if (!conversationId) return;
    const unsub = realtime.subscribe({ conversationId });
    const off = realtime.on(
      (e) => {
        if (e.conversationId !== conversationId) return;
        const data = e.data as {
          messageId?: string;
          delta?: string;
          callId?: string;
          tool?: string;
          title?: string;
          status?: ToolCallPart['status'];
          summary?: string | null;
          message?: Message;
        };
        const messageId = data.messageId;
        if (!messageId) return;
        if (e.type === 'agent.message.delta' && data.delta) {
          setStreams((s) => ({ ...s, [messageId]: { text: (s[messageId]?.text ?? '') + data.delta, tools: s[messageId]?.tools ?? [] } }));
        } else if (e.type === 'agent.tool.started' || e.type === 'agent.tool.completed') {
          setStreams((s) => {
            const cur = s[messageId] ?? { text: '', tools: [] };
            const part: ToolCallPart = {
              type: 'tool_call',
              callId: data.callId ?? '',
              tool: data.tool ?? '',
              title: data.title ?? data.tool ?? 'Tool',
              status: e.type === 'agent.tool.started' ? 'running' : (data.status ?? 'succeeded'),
              summary: data.summary ?? undefined,
            };
            const tools = cur.tools.some((t) => t.callId === part.callId)
              ? cur.tools.map((t) => (t.callId === part.callId ? part : t))
              : [...cur.tools, part];
            return { ...s, [messageId]: { ...cur, tools } };
          });
        } else if (e.type === 'agent.message.completed' && data.message) {
          const msg = data.message;
          qc.setQueryData<ConversationDetail>(qk.conversation(conversationId), (old) => {
            if (!old) return old;
            const exists = old.messages.some((m) => m.id === msg.id);
            return { ...old, messages: exists ? old.messages.map((m) => (m.id === msg.id ? msg : m)) : [...old.messages, msg] };
          });
          setStreams((s) => {
            const { [messageId]: _done, ...rest } = s;
            return rest;
          });
          void qc.invalidateQueries({ queryKey: qk.conversations });
        }
      },
      (t) => t.startsWith('agent.'),
    );
    return () => {
      off();
      unsub();
    };
  }, [conversationId, qc]);

  const send = useCallback(
    async (content: string, opts: { pageContext?: PageContext | null; projectId?: string | null } = {}): Promise<string> => {
      let id = idRef.current;
      if (!id) {
        const created = await api.post<Conversation>('/conversations', {
          projectId: opts.projectId ?? opts.pageContext?.projectId ?? undefined,
        });
        id = created.id;
        qc.setQueryData<ConversationDetail>(qk.conversation(id), { ...created, messages: [] });
        // Join the room before the turn starts so no deltas are missed; the view's own
        // subscription takes over once it renders with the new id.
        const release = realtime.subscribe({ conversationId: id });
        setTimeout(release, 30_000);
      }
      const res = await api.post<{ userMessage: Message; assistantMessage: Message }>(`/conversations/${id}/messages`, {
        content,
        pageContext: opts.pageContext ?? undefined,
      });
      qc.setQueryData<ConversationDetail>(qk.conversation(id), (old) =>
        old
          ? {
              ...old,
              messages: [
                ...old.messages.filter((m) => m.id !== res.userMessage.id && m.id !== res.assistantMessage.id),
                res.userMessage,
                res.assistantMessage,
              ],
            }
          : old,
      );
      void qc.invalidateQueries({ queryKey: qk.conversations });
      return id;
    },
    [qc],
  );

  const cancel = useCallback(async () => {
    if (idRef.current) await api.post(`/conversations/${idRef.current}/cancel`);
  }, []);

  const messages = conversation.data?.messages ?? [];
  const responding = messages.some((m) => m.status === 'streaming');
  return { conversation, messages, streams, send, cancel, responding };
}

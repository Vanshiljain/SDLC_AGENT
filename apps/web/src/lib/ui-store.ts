import { useSyncExternalStore } from 'react';
import type { PageContext } from '@forgeline/shared';

/** Global UI state shared by the shell, command palette and assistant. */
interface UiState {
  paletteOpen: boolean;
  assistantOpen: boolean;
  /** Conversation shown in the global assistant panel. */
  assistantConversationId: string | null;
  /** A prompt queued for the assistant (e.g. from the Command Center or ⌘K). */
  assistantDraft: { text: string; send: boolean; nonce: number } | null;
  pageContext: PageContext | null;
}

let state: UiState = { paletteOpen: false, assistantOpen: false, assistantConversationId: null, assistantDraft: null, pageContext: null };
const listeners = new Set<() => void>();

export const ui = {
  get: () => state,
  set(patch: Partial<UiState>) {
    state = { ...state, ...patch };
    listeners.forEach((l) => l());
  },
  subscribe(l: () => void) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
  /** Opens the assistant with a prompt, optionally sending it immediately. */
  ask(text: string, send = true) {
    ui.set({ assistantOpen: true, paletteOpen: false, assistantDraft: { text, send, nonce: Date.now() } });
  },
};

export function useUi<T>(select: (s: UiState) => T): T {
  return useSyncExternalStore(ui.subscribe, () => select(state));
}

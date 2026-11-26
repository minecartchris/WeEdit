import { create } from "zustand";

// Collaboration chat, as the UI sees it. The messages themselves live in the
// session's Y.Doc (lib/collab/chat.ts), so everyone in the room — desktop or
// browser — sees the same history, including what was said before they joined.
// Like state/collab this file stays free of yjs so the editor doesn't load the
// collab stack until a session starts.

export interface ChatMessage {
  id: string;
  /** Awareness clientID of the author (to tell "me" apart). */
  clientId: number;
  name: string;
  color: string;
  text: string;
  /** Epoch ms when it was sent (sender's clock). */
  at: number;
}

interface ChatState {
  messages: ChatMessage[];
  open: boolean;
  /** Messages from others that arrived while the panel was closed. */
  unread: number;
  selfClientId: number | null;
  setOpen: (open: boolean) => void;
  /** Wired by the active session; a no-op when no session is running. */
  send: (text: string) => void;
}

export const MAX_CHAT_CHARS = 1000;

export const useChat = create<ChatState>((set) => ({
  messages: [],
  open: false,
  unread: 0,
  selfClientId: null,
  setOpen: (open) => set(open ? { open, unread: 0 } : { open }),
  send: () => {},
}));

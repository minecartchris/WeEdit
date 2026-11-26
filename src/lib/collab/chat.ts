import * as Y from "yjs";
import { MAX_CHAT_CHARS, useChat, type ChatMessage } from "@/state/chat";

// Chat for a collaboration session: a shared Y.Array in the project doc. It
// rides the same peer-to-peer connection as the edits, so there's no server
// involved and late joiners get the history with the rest of the project.

/** Keep the doc light: older messages are trimmed past this many. */
const MAX_MESSAGES = 300;

/**
 * Bind the chat store to `doc` for the session's lifetime. `identity` is read
 * at send time so a rename mid-session shows up on new messages.
 */
export function bindChat(
  doc: Y.Doc,
  clientId: number,
  identity: () => { name: string; color: string },
): () => void {
  const arr = doc.getArray<ChatMessage>("chat");

  const sync = (fromRemote: boolean) => {
    const messages = arr.toArray();
    useChat.setState((s) => {
      // By id, not by length: trimming old messages can hide new ones in a count.
      const seen = new Set(s.messages.map((m) => m.id));
      const fromOthers = fromRemote
        ? messages.filter((m) => !seen.has(m.id) && m.clientId !== clientId).length
        : 0;
      return { messages, unread: s.open ? 0 : s.unread + fromOthers };
    });
  };

  const onChange = (_e: Y.YArrayEvent<ChatMessage>, tx: Y.Transaction) => sync(!tx.local);
  arr.observe(onChange);
  useChat.setState({ messages: arr.toArray(), unread: 0, selfClientId: clientId });

  useChat.setState({
    send: (raw: string) => {
      const text = raw.trim().slice(0, MAX_CHAT_CHARS);
      if (!text) return;
      const { name, color } = identity();
      const msg: ChatMessage = { id: crypto.randomUUID(), clientId, name, color, text, at: Date.now() };
      doc.transact(() => {
        arr.push([msg]);
        const extra = arr.length - MAX_MESSAGES;
        if (extra > 0) arr.delete(0, extra);
      });
    },
  });

  return () => {
    arr.unobserve(onChange);
    useChat.setState({ messages: [], unread: 0, open: false, selfClientId: null, send: () => {} });
  };
}

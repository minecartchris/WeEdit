import { MessageSquare, Send, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { MAX_CHAT_CHARS, useChat } from "@/state/chat";
import { useCollab } from "@/state/collab";

// Floating chat for a collaboration session: a bubble in the bottom-left corner
// (with an unread count) that opens a small panel. Only shown while connected.
// Keys typed here must not reach the editor's shortcuts (Space = play, S = split,
// Delete = delete clip…), so the input stops them from bubbling.
export function CollabChat() {
  const status = useCollab((s) => s.status);
  const peerCount = useCollab((s) => s.peerCount);
  const messages = useChat((s) => s.messages);
  const open = useChat((s) => s.open);
  const unread = useChat((s) => s.unread);
  const selfClientId = useChat((s) => s.selfClientId);
  const setOpen = useChat((s) => s.setOpen);
  const send = useChat((s) => s.send);
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, open]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  if (status !== "connected") return null;

  const submit = () => {
    if (!draft.trim()) return;
    send(draft);
    setDraft("");
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-4 left-4 z-40 h-11 px-3.5 rounded-full bg-we-teal text-white shadow-lg flex items-center gap-2 text-sm font-medium hover:opacity-90"
        title="Chat with your collaborators"
        aria-label="Open chat"
      >
        <MessageSquare className="w-4 h-4" />
        Chat
        {unread > 0 && (
          <span className="min-w-5 h-5 px-1 rounded-full bg-red-500 text-[11px] grid place-items-center tabular-nums">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
    );
  }

  return (
    <div className="fixed bottom-4 left-4 z-40 w-80 h-96 max-h-[70vh] rounded-xl border border-we-border bg-we-panel shadow-2xl flex flex-col overflow-hidden">
      <div className="h-10 shrink-0 flex items-center gap-2 px-3 border-b border-we-border">
        <MessageSquare className="w-4 h-4 text-we-teal" />
        <span className="text-sm font-medium text-we-ink">Session chat</span>
        <span className="text-[11px] text-we-muted">{peerCount + 1} here</span>
        <button onClick={() => setOpen(false)} className="ml-auto we-btn-ghost p-1" aria-label="Close chat">
          <X className="w-4 h-4" />
        </button>
      </div>

      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto px-3 py-2 flex flex-col gap-2">
        {messages.length === 0 ? (
          <p className="m-auto text-xs text-we-muted text-center">
            No messages yet. Say hi — everyone in the session sees this.
          </p>
        ) : (
          messages.map((m) => {
            const mine = m.clientId === selfClientId;
            return (
              <div key={m.id} className={mine ? "self-end max-w-[85%]" : "self-start max-w-[85%]"}>
                {!mine && (
                  <div className="text-[11px] font-medium mb-0.5" style={{ color: m.color }}>
                    {m.name}
                  </div>
                )}
                <div
                  className={[
                    "rounded-lg px-2.5 py-1.5 text-sm whitespace-pre-wrap break-words",
                    mine ? "bg-we-teal text-white" : "bg-we-hover text-we-ink",
                  ].join(" ")}
                  title={new Date(m.at).toLocaleString()}
                >
                  {m.text}
                </div>
              </div>
            );
          })
        )}
      </div>

      <form
        className="shrink-0 flex items-center gap-2 p-2 border-t border-we-border"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          ref={inputRef}
          value={draft}
          maxLength={MAX_CHAT_CHARS}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation(); // don't trigger editor shortcuts while typing
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="Message everyone…"
          className="we-input flex-1 min-w-0"
        />
        <button type="submit" className="we-btn-primary p-2" disabled={!draft.trim()} aria-label="Send">
          <Send className="w-4 h-4" />
        </button>
      </form>
    </div>
  );
}

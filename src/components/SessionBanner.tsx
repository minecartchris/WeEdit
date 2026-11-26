import { Eye, RefreshCw, X } from "lucide-react";
import { useState } from "react";
import { joinFromInvite } from "@/lib/invites";
import { useCollab } from "@/state/collab";

// Thin strip under the top bar for collaboration states that need attention:
//   - "Rejoin?" when the app was closed (or crashed) while in a session
//   - "View only" while the host hasn't given this user edit rights
export function SessionBanner() {
  const status = useCollab((s) => s.status);
  const myRole = useCollab((s) => s.myRole);
  const lastSession = useCollab((s) => s.lastSession);
  const dismissRejoin = useCollab((s) => s.dismissRejoin);
  const [busy, setBusy] = useState(false);

  if (status === "connected" && myRole === "view") {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-100 border-b border-amber-300/50">
        <Eye className="w-3.5 h-3.5" />
        View only — you can watch and chat; the host can give you edit access.
      </div>
    );
  }

  if (status === "idle" && lastSession) {
    return (
      <div className="shrink-0 flex items-center gap-2 px-4 py-1.5 text-xs bg-we-teal/10 text-we-ink border-b border-we-teal/30">
        <RefreshCw className="w-3.5 h-3.5 text-we-teal" />
        You were in collaboration session <code className="font-mono">{lastSession.roomId}</code> when WeEdit
        closed.
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void joinFromInvite(lastSession.roomId).finally(() => setBusy(false));
          }}
          className="we-btn-primary text-xs py-0.5 px-2 disabled:opacity-50"
        >
          Rejoin
        </button>
        <button onClick={dismissRejoin} className="ml-auto we-btn-ghost p-1" aria-label="Dismiss">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    );
  }

  return null;
}

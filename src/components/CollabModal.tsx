import { Check, Copy, Crown, Eye, LogOut, Pencil, Radio, UserMinus, UserPlus, Users } from "lucide-react";
import { useMemo, useState } from "react";
import { CollabDownloadSetting } from "@/components/CollabDownloadSetting";
import { Modal } from "@/components/ui/Modal";
import { isTauri } from "@/lib/platform";
import { desktopInviteLink, webInviteLink } from "@/lib/invites";
import { useCollab } from "@/state/collab";
import { pickCollabMediaDir, usePrefs } from "@/state/prefs";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Start or join a real-time collaboration session. The session link is just a
// room code — anyone with it joins the same y-webrtc room over public signaling
// (no port forwarding, nothing to host). Media files sync separately (Phase 3).
export function CollabModal({ open, onClose }: Props) {
  const status = useCollab((s) => s.status);
  const roomId = useCollab((s) => s.roomId);
  const selfName = useCollab((s) => s.selfName);
  const selfColor = useCollab((s) => s.selfColor);
  const setSelfName = useCollab((s) => s.setSelfName);
  const peersRecord = useCollab((s) => s.peers);
  const start = useCollab((s) => s.start);
  const join = useCollab((s) => s.join);
  const leave = useCollab((s) => s.leave);
  const myRole = useCollab((s) => s.myRole);
  const guestRole = useCollab((s) => s.guestRole);
  const setPeerRole = useCollab((s) => s.setPeerRole);
  const kickPeer = useCollab((s) => s.kickPeer);
  const setGuestRole = useCollab((s) => s.setGuestRole);
  const isHost = myRole === "host";

  const peers = useMemo(() => Object.values(peersRecord), [peersRecord]);
  const [joinCode, setJoinCode] = useState("");
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const [copiedWhat, setCopiedWhat] = useState<"code" | "web" | "app" | null>(null);

  const copy = async (what: "code" | "web" | "app") => {
    if (!roomId) return;
    const text = what === "code" ? roomId : what === "web" ? webInviteLink(roomId) : desktopInviteLink(roomId);
    try {
      await navigator.clipboard.writeText(text);
      setCopiedWhat(what);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setCopiedWhat(null);
      }, 1500);
    } catch (err) {
      console.error("Clipboard write failed:", err);
    }
  };
  const onCopy = () => copy("code");

  const onStart = async () => {
    setBusy(true);
    try {
      await start();
    } catch (err) {
      console.error("Failed to start session:", err);
      window.alert("Couldn't start the session. See console for details.");
    } finally {
      setBusy(false);
    }
  };

  const onJoin = async () => {
    const code = joinCode.trim();
    if (!code) return;
    // Saving downloads to a folder of their own, but none chosen yet: ask first.
    const prefs = usePrefs.getState();
    if (isTauri() && !prefs.collabMediaTemp && !prefs.collabMediaDir) {
      const picked = await pickCollabMediaDir();
      if (!picked) return;
    }
    setBusy(true);
    try {
      await join(code);
    } catch (err) {
      console.error("Failed to join session:", err);
      window.alert("Couldn't join the session. Check the code and try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Collaborate" width="500px">
      <div className="p-5 flex flex-col gap-5">
        {/* Identity */}
        <div className="flex items-center gap-3">
          <span
            className="w-8 h-8 rounded-full grid place-items-center text-white text-sm font-semibold shrink-0"
            style={{ backgroundColor: selfColor }}
          >
            {selfName.charAt(0).toUpperCase()}
          </span>
          <label className="flex-1 min-w-0">
            <span className="sr-only">Your name</span>
            <input
              value={selfName}
              onChange={(e) => setSelfName(e.target.value)}
              placeholder="Your name"
              className="we-input"
            />
          </label>
        </div>

        {status === "connected" ? (
          <>
            <div className="rounded-lg border border-we-border p-4 flex flex-col gap-3">
              <div className="flex items-center gap-2 text-sm text-we-ink">
                <Radio className="w-4 h-4 text-we-teal animate-pulse" />
                Session live — share this code to invite editors
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-we-panel border border-we-border px-3 py-2 text-base font-mono tracking-widest text-we-ink text-center select-all">
                  {roomId}
                </code>
                <button onClick={() => void onCopy()} className="we-btn shrink-0" title="Copy code">
                  {copied ? <Check className="w-4 h-4 text-we-teal" /> : <Copy className="w-4 h-4" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                <button onClick={() => void copy("web")} className="we-btn text-xs py-1" title={roomId ? webInviteLink(roomId) : ""}>
                  {copiedWhat === "web" ? <Check className="w-3.5 h-3.5 text-we-teal" /> : <Copy className="w-3.5 h-3.5" />}
                  Copy invite link
                </button>
                <button onClick={() => void copy("app")} className="we-btn text-xs py-1" title={roomId ? desktopInviteLink(roomId) : ""}>
                  {copiedWhat === "app" ? <Check className="w-3.5 h-3.5 text-we-teal" /> : <Copy className="w-3.5 h-3.5" />}
                  Copy desktop-app link
                </button>
              </div>
              <p className="text-[11px] text-we-muted leading-4">
                The invite link opens the session in a browser — anyone can join with no install. The
                desktop-app link opens WeEdit directly for people who have it.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2 text-xs text-we-muted">
                <Users className="w-3.5 h-3.5" />
                {peers.length === 0
                  ? "Waiting for others to join…"
                  : `${peers.length} other ${peers.length === 1 ? "editor" : "editors"} connected`}
              </div>
              {peers.map((p) => (
                <div key={p.clientId} className="flex items-center gap-2 text-sm text-we-ink">
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: p.color }} />
                  <span className="truncate">{p.name}</span>
                  {p.role === "host" ? (
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-amber-600">
                      <Crown className="w-3.5 h-3.5" /> Host
                    </span>
                  ) : isHost ? (
                    <span className="ml-auto flex items-center gap-1">
                      <select
                        value={p.role}
                        onChange={(e) => setPeerRole(p.pid, e.target.value as "edit" | "view")}
                        className="we-input py-0.5 text-xs w-auto"
                        title="What this person can do"
                      >
                        <option value="edit">Can edit</option>
                        <option value="view">View only</option>
                      </select>
                      <button
                        onClick={() => {
                          if (window.confirm(`Remove ${p.name} from the session?`)) kickPeer(p.pid);
                        }}
                        className="we-btn-ghost p-1 text-red-600"
                        title={`Remove ${p.name} from the session`}
                      >
                        <UserMinus className="w-3.5 h-3.5" />
                      </button>
                    </span>
                  ) : (
                    <span className="ml-auto flex items-center gap-1 text-[11px] text-we-muted">
                      {p.role === "view" ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                      {p.role === "view" ? "View only" : "Editor"}
                    </span>
                  )}
                </div>
              ))}
            </div>

            {isHost ? (
              <label className="flex items-center gap-2 text-xs text-we-muted">
                New people who join can
                <select
                  value={guestRole}
                  onChange={(e) => setGuestRole(e.target.value as "edit" | "view")}
                  className="we-input py-0.5 text-xs w-auto"
                >
                  <option value="edit">edit</option>
                  <option value="view">only watch</option>
                </select>
              </label>
            ) : (
              <p className="text-xs text-we-muted flex items-center gap-1.5">
                {myRole === "view" ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                {myRole === "view"
                  ? "You're view-only in this session — the host can give you edit access."
                  : "You can edit this project."}
              </p>
            )}

            <p className="text-[11px] text-we-muted leading-4">
              Public signaling can be flaky on strict home networks. Edits and cursors sync live;
              media files transfer peer-to-peer on demand (large VODs are slow — a shared NAS is
              faster).
            </p>

            <button onClick={leave} className="we-btn self-start text-red-600 border-red-300 hover:bg-red-50">
              <LogOut className="w-4 h-4" />
              Leave session
            </button>
          </>
        ) : (
          <>
            <button
              onClick={() => void onStart()}
              disabled={busy || status === "connecting"}
              className="we-btn-primary justify-center py-2.5 disabled:opacity-50"
            >
              <UserPlus className="w-4 h-4" />
              {status === "connecting" ? "Connecting…" : "Start a session"}
            </button>

            <div className="flex items-center gap-3 text-xs text-we-muted">
              <div className="flex-1 h-px bg-we-border" />
              or join one
              <div className="flex-1 h-px bg-we-border" />
            </div>

            <div className="flex items-center gap-2">
              <input
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void onJoin();
                }}
                placeholder="Paste session code"
                className="we-input flex-1 min-w-0 font-mono"
              />
              <button
                onClick={() => void onJoin()}
                disabled={busy || !joinCode.trim()}
                className="we-btn shrink-0 disabled:opacity-50"
              >
                Join
              </button>
            </div>

            <CollabDownloadSetting compact />

            <p className="text-[11px] text-we-muted leading-4">
              No accounts, no port forwarding. Joining replaces your current timeline with the
              shared project.
            </p>
          </>
        )}
      </div>
    </Modal>
  );
}

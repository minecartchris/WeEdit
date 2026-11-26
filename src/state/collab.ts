import { create } from "zustand";
import type { GuestRole, SessionControl, SessionRole } from "@/lib/collab/sessionControl";
import { useEditor } from "@/state/editor";

// Collaboration session state + live presence ("awareness"). Orchestrates the
// Y.Doc session (collabDoc) and the store binding (bindStore), and surfaces each
// connected peer's playhead + selection so the timeline can draw their cursors.
//
// LAZY BY DESIGN: this store is lightweight and pulls in NONE of the heavy
// collab stack at import time. yjs / y-webrtc / the store binding / media sync
// are dynamically imported only when the user actually starts or joins a session
// (see `connect`). So a normal solo editing session never loads or runs the
// multi-user machinery — nothing connects to signaling, nothing subscribes.
//
// Presence note: `peers` is kept as a STABLE Record keyed by clientId and only
// the changed handler replaces it — components must derive arrays with useMemo
// (never a fresh-array Zustand selector; that breaks useSyncExternalStore).

// Minimal shape of the y-protocols Awareness we touch (typed locally so this
// file doesn't import yjs).
interface AwarenessLike {
  clientID: number;
  setLocalState: (state: Record<string, unknown>) => void;
  setLocalStateField: (field: string, value: unknown) => void;
  getStates: () => Map<number, Record<string, unknown>>;
  on: (event: "change", cb: () => void) => void;
  off: (event: "change", cb: () => void) => void;
}

export type CollabStatus = "idle" | "connecting" | "connected";

export interface PeerPresence {
  clientId: number;
  /** Persistent per-install id (stable across reconnects); roles are keyed by it. */
  pid: string;
  role: SessionRole;
  name: string;
  color: string;
  playheadSec: number;
  selectedClipIds: string[];
}

interface CollabState {
  status: CollabStatus;
  roomId: string | null;
  selfName: string;
  selfColor: string;
  /** Remote peers only (excludes self), keyed by clientId. */
  peers: Record<number, PeerPresence>;
  peerCount: number;
  /** This user's role in the session ("host" for whoever started it). */
  myRole: SessionRole;
  /** Role new guests get unless the host sets theirs. */
  guestRole: GuestRole;
  /** The session this install was last in (for "Rejoin?"), or null. */
  lastSession: { roomId: string; at: number } | null;

  start: () => Promise<string>;
  join: (roomId: string) => Promise<void>;
  leave: () => void;
  setSelfName: (name: string) => void;
  setPeerRole: (pid: string, role: GuestRole) => void;
  kickPeer: (pid: string) => void;
  setGuestRole: (role: GuestRole) => void;
  dismissRejoin: () => void;
}

// Distinct, readable cursor colors.
const COLORS = [
  "#ef4444", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

const LAST_SESSION_KEY = "weedit.collab.lastSession";
/** Offer to rejoin a session for this long after leaving it unexpectedly. */
const REJOIN_WINDOW_MS = 24 * 60 * 60 * 1000;

function loadLastSession(): { roomId: string; at: number } | null {
  try {
    const raw = JSON.parse(localStorage.getItem(LAST_SESSION_KEY) || "null");
    if (raw && typeof raw.roomId === "string" && Date.now() - raw.at < REJOIN_WINDOW_MS) return raw;
  } catch {
    // ignore
  }
  return null;
}

function rememberSession(roomId: string | null): void {
  if (roomId) localStorage.setItem(LAST_SESSION_KEY, JSON.stringify({ roomId, at: Date.now() }));
  else localStorage.removeItem(LAST_SESSION_KEY);
}

function loadPid(): string {
  let pid = localStorage.getItem("weedit.collab.pid");
  if (!pid) {
    pid = crypto.randomUUID();
    localStorage.setItem("weedit.collab.pid", pid);
  }
  return pid;
}

function loadIdentity(): { name: string; color: string } {
  const name = localStorage.getItem("weedit.collab.name") || randomName();
  const color =
    localStorage.getItem("weedit.collab.color") ||
    COLORS[Math.floor(Math.random() * COLORS.length)];
  localStorage.setItem("weedit.collab.name", name);
  localStorage.setItem("weedit.collab.color", color);
  return { name, color };
}

function randomName(): string {
  const animals = ["Otter", "Falcon", "Lynx", "Heron", "Bison", "Marten", "Raven", "Ibex"];
  return `${animals[Math.floor(Math.random() * animals.length)]} ${Math.floor(Math.random() * 90 + 10)}`;
}

// Live bookkeeping for the active session (not in the store — these are plain
// mutable handles that the store actions wire up and tear down). All references
// to the heavy modules are captured here from the dynamic import in `connect`,
// so `teardown` / `setSelfName` never need a static import of the collab stack.
let unbind: (() => void) | null = null;
let enableLocal: (() => void) | null = null;
let unsubEditor: (() => void) | null = null;
let awarenessHandler: (() => void) | null = null;
let emptyRoomTimer: number | null = null;
let lastPlayheadWrite = 0;
let activeAwareness: AwarenessLike | null = null;
let teardownSession: (() => void) | null = null; // destroySession + stopMediaSync
let control: SessionControl | null = null;

const identity = loadIdentity();
const selfPid = loadPid();

export const useCollab = create<CollabState>((set, get) => ({
  status: "idle",
  roomId: null,
  selfName: identity.name,
  selfColor: identity.color,
  peers: {},
  peerCount: 0,
  myRole: "edit",
  guestRole: "edit",
  // A session still on record at startup means the app closed or crashed while
  // in it — offer to go back.
  lastSession: loadLastSession(),

  start: async () => {
    const roomId = crypto.randomUUID().slice(0, 8);
    await connect(roomId, true, set, get);
    return roomId;
  },

  join: async (roomId) => {
    await connect(roomId.trim(), false, set, get);
  },

  leave: () => {
    teardown();
    rememberSession(null); // a deliberate leave: don't offer to rejoin
    set({ status: "idle", roomId: null, peers: {}, peerCount: 0, myRole: "edit", lastSession: null });
  },

  setPeerRole: (pid, role) => control?.setRole(pid, role),
  kickPeer: (pid) => control?.kick(pid),
  setGuestRole: (role) => control?.setGuestRole(role),
  dismissRejoin: () => {
    rememberSession(null);
    set({ lastSession: null });
  },

  setSelfName: (name) => {
    const trimmed = name.trim() || randomName();
    localStorage.setItem("weedit.collab.name", trimmed);
    set({ selfName: trimmed });
    activeAwareness?.setLocalStateField("name", trimmed);
  },
}));

async function connect(
  roomId: string,
  isHost: boolean,
  set: (partial: Partial<CollabState>) => void,
  get: () => CollabState,
): Promise<void> {
  teardown();
  set({ status: "connecting", roomId, peers: {}, peerCount: 0 });

  // Load the heavy collab stack on demand — this is the first point a normal
  // editing session ever touches yjs / y-webrtc / WebRTC.
  const [
    { createSession, destroySession },
    { bindEditorToDoc },
    { startMediaSync, stopMediaSync },
    { bindChat },
    { bindSessionControl },
    { bindRemoteExport },
  ] = await Promise.all([
    import("@/lib/collab/collabDoc"),
    import("@/lib/collab/bindStore"),
    import("@/lib/collab/mediaSync"),
    import("@/lib/collab/chat"),
    import("@/lib/collab/sessionControl"),
    import("@/lib/collab/remoteExport"),
  ]);

  // Joining adopts someone else's project. Detach from any file the user had
  // open (e.g. another project) so Ctrl+S / auto-save can't overwrite it with
  // the collab content — the session is treated as an unsaved project until the
  // user explicitly Saves As. The host keeps its path (it's sharing its own
  // project, so saving to it is intended).
  if (!isHost) {
    useEditor.setState({ projectPath: null, lastSavedAt: null });
  }

  const { iceServers } = await import("@/lib/collab/config");
  const session = createSession(roomId, await iceServers());

  const ctl = bindSessionControl(session.doc, selfPid, isHost, {
    onChange: () => {
      set({ myRole: ctl.myRole(), guestRole: ctl.guestRole() });
      awarenessHandler?.(); // peers' roles may have changed
    },
    onKicked: () => {
      // Defer: we're inside a Yjs observer, and leaving destroys the doc.
      setTimeout(() => {
        get().leave();
        window.alert("The host removed you from this collaboration session.");
      }, 0);
    },
  });
  control = ctl;
  set({ myRole: ctl.myRole(), guestRole: ctl.guestRole() });

  const bound = bindEditorToDoc(session.maps, isHost, { canEdit: () => ctl.myRole() !== "view" });
  unbind = bound.unbind;
  enableLocal = bound.enableLocal;
  const unbindChat = bindChat(session.doc, session.provider.awareness.clientID, () => ({
    name: get().selfName,
    color: get().selfColor,
  }));
  const unbindExports = bindRemoteExport(
    session.doc,
    selfPid,
    () => ({ name: get().selfName }),
    () => ctl.myRole() === "host",
  );
  teardownSession = () => {
    unbindExports();
    ctl.unbind();
    unbindChat();
    void stopMediaSync();
    destroySession();
  };

  // Seed our awareness state.
  const aw = session.provider.awareness as unknown as AwarenessLike;
  activeAwareness = aw;
  const { selfName, selfColor } = get();
  aw.setLocalState({
    pid: selfPid,
    name: selfName,
    color: selfColor,
    playheadSec: useEditor.getState().playheadSec,
    selectedClipIds: useEditor.getState().selectedClipIds,
  });

  // Mirror local playhead + selection into awareness (throttle the playhead).
  unsubEditor = useEditor.subscribe((s, prev) => {
    if (s.selectedClipIds !== prev.selectedClipIds) {
      aw.setLocalStateField("selectedClipIds", s.selectedClipIds);
    }
    if (s.playheadSec !== prev.playheadSec) {
      const now = performance.now();
      if (now - lastPlayheadWrite > 40) {
        lastPlayheadWrite = now;
        aw.setLocalStateField("playheadSec", s.playheadSec);
      }
    }
  });

  // Rebuild the peers record (excluding self) whenever awareness changes.
  awarenessHandler = () => {
    const peers: Record<number, PeerPresence> = {};
    aw.getStates().forEach((state, clientId) => {
      if (clientId === aw.clientID || !state) return;
      const p = state as Partial<PeerPresence>;
      const pid = typeof p.pid === "string" ? p.pid : `client-${clientId}`;
      peers[clientId] = {
        clientId,
        pid,
        role: control ? control.roleOf(pid) : "edit",
        name: typeof p.name === "string" ? p.name : "Guest",
        color: typeof p.color === "string" ? p.color : "#888",
        playheadSec: typeof p.playheadSec === "number" ? p.playheadSec : 0,
        selectedClipIds: Array.isArray(p.selectedClipIds) ? p.selectedClipIds : [],
      };
    });
    set({ peers, peerCount: Object.keys(peers).length });
  };
  aw.on("change", awarenessHandler);

  // Peer-to-peer media transfer so previews resolve on every peer.
  void startMediaSync(roomId, session.provider).catch((err) =>
    console.error("Failed to start media sync:", err),
  );

  set({ status: "connected", lastSession: null });
  rememberSession(roomId); // cleared on a deliberate leave; kept if the app dies

  // If we joined an empty room (host never seeded), start contributing after a
  // grace period so the room isn't stuck blank.
  if (!isHost) {
    emptyRoomTimer = window.setTimeout(() => {
      enableLocal?.();
    }, 4000);
  }
}

function teardown(): void {
  if (emptyRoomTimer != null) {
    clearTimeout(emptyRoomTimer);
    emptyRoomTimer = null;
  }
  if (activeAwareness && awarenessHandler) activeAwareness.off("change", awarenessHandler);
  awarenessHandler = null;
  activeAwareness = null;
  unsubEditor?.();
  unsubEditor = null;
  unbind?.();
  unbind = null;
  enableLocal = null;
  teardownSession?.(); // stopMediaSync + destroySession (no-op before first connect)
  teardownSession = null;
  control = null;
}

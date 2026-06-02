import { create } from "zustand";
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

  start: () => Promise<string>;
  join: (roomId: string) => Promise<void>;
  leave: () => void;
  setSelfName: (name: string) => void;
}

// Distinct, readable cursor colors.
const COLORS = [
  "#ef4444", "#f59e0b", "#10b981", "#3b82f6",
  "#8b5cf6", "#ec4899", "#14b8a6", "#f97316",
];

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

const identity = loadIdentity();

export const useCollab = create<CollabState>((set, get) => ({
  status: "idle",
  roomId: null,
  selfName: identity.name,
  selfColor: identity.color,
  peers: {},
  peerCount: 0,

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
    set({ status: "idle", roomId: null, peers: {}, peerCount: 0 });
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
  const [{ createSession, destroySession }, { bindEditorToDoc }, { startMediaSync, stopMediaSync }] =
    await Promise.all([
      import("@/lib/collab/collabDoc"),
      import("@/lib/collab/bindStore"),
      import("@/lib/collab/mediaSync"),
    ]);

  const session = createSession(roomId);
  const bound = bindEditorToDoc(session.maps, isHost);
  unbind = bound.unbind;
  enableLocal = bound.enableLocal;
  teardownSession = () => {
    void stopMediaSync();
    destroySession();
  };

  // Seed our awareness state.
  const aw = session.provider.awareness as unknown as AwarenessLike;
  activeAwareness = aw;
  const { selfName, selfColor } = get();
  aw.setLocalState({
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
      peers[clientId] = {
        clientId,
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

  set({ status: "connected" });

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
}

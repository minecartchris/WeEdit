import { create } from "zustand";
import { bindEditorToDoc } from "@/lib/collab/bindStore";
import { createSession, destroySession, getSession } from "@/lib/collab/collabDoc";
import { useEditor } from "@/state/editor";

// Collaboration session state + live presence ("awareness"). Orchestrates the
// Y.Doc session (collabDoc) and the store binding (bindStore), and surfaces each
// connected peer's playhead + selection so the timeline can draw their cursors.
//
// Presence note: `peers` is kept as a STABLE Record keyed by clientId and only
// the changed handler replaces it — components must derive arrays with useMemo
// (never a fresh-array Zustand selector; that breaks useSyncExternalStore).

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
// mutable handles that the store actions wire up and tear down).
let unbind: (() => void) | null = null;
let enableLocal: (() => void) | null = null;
let unsubEditor: (() => void) | null = null;
let awarenessHandler: (() => void) | null = null;
let emptyRoomTimer: number | null = null;
let lastPlayheadWrite = 0;

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
    const s = getSession();
    if (s) s.provider.awareness.setLocalStateField("name", trimmed);
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

  const session = createSession(roomId);
  const bound = bindEditorToDoc(session.maps, isHost);
  unbind = bound.unbind;
  enableLocal = bound.enableLocal;

  // Seed our awareness state.
  const aw = session.provider.awareness;
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
  const s = getSession();
  if (s && awarenessHandler) s.provider.awareness.off("change", awarenessHandler);
  awarenessHandler = null;
  unsubEditor?.();
  unsubEditor = null;
  unbind?.();
  unbind = null;
  enableLocal = null;
  destroySession();
}

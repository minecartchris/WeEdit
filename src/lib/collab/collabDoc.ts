import { WebrtcProvider } from "y-webrtc";
import * as Y from "yjs";

// Low-level collaboration session: a single Y.Doc synced peer-to-peer over
// y-webrtc using public signaling servers (no hosted infra, no port forwarding —
// the signaling servers only introduce peers; edits flow directly P2P).
//
// The shared document is split into four top-level Y.Maps mirroring the editor's
// content slices. Entities are stored whole-object, keyed by id, so two people
// editing different clips merge cleanly (last-writer-wins per entity on the rare
// same-entity conflict — acceptable for v1).
//
//   project : Y.Map  — key "data" → ProjectMeta, key "trackOrder" → string[]
//   media   : Y.Map<mediaId, MediaItem>
//   tracks  : Y.Map<trackId, Track>
//   clips   : Y.Map<clipId, Clip>

// Public signaling servers. They only broker the WebRTC handshake; if one is
// down the others still connect peers. Reliability of public signaling varies —
// surfaced honestly in the collab UI.
const SIGNALING = ["wss://signaling.yjs.dev", "wss://demos.yjs.dev"];

/** Transaction origin tag for our own writes, so observers can skip the echo. */
export const LOCAL_ORIGIN = Symbol("weedit-local");

export interface CollabMaps {
  project: Y.Map<unknown>;
  media: Y.Map<unknown>;
  tracks: Y.Map<unknown>;
  clips: Y.Map<unknown>;
}

export interface CollabSession {
  doc: Y.Doc;
  provider: WebrtcProvider;
  maps: CollabMaps;
  roomId: string;
}

let session: CollabSession | null = null;

export function getSession(): CollabSession | null {
  return session;
}

/** Create + connect a session for `roomId`. Tears down any existing one first. */
export function createSession(roomId: string): CollabSession {
  destroySession();
  const doc = new Y.Doc();
  const provider = new WebrtcProvider(`weedit-${roomId}`, doc, {
    signaling: SIGNALING,
  });
  const maps: CollabMaps = {
    project: doc.getMap("project"),
    media: doc.getMap("media"),
    tracks: doc.getMap("tracks"),
    clips: doc.getMap("clips"),
  };
  session = { doc, provider, maps, roomId };
  return session;
}

export function destroySession(): void {
  if (!session) return;
  try {
    session.provider.destroy();
    session.doc.destroy();
  } catch (err) {
    console.error("Error tearing down collab session:", err);
  }
  session = null;
}

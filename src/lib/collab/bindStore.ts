import * as Y from "yjs";
import { normalizeClips } from "@/lib/clips";
import { LOCAL_ORIGIN, type CollabMaps } from "@/lib/collab/collabDoc";
import { useEditor } from "@/state/editor";
import type { Clip, MediaItem, ProjectMeta, Track } from "@/types";

// Reconciling bridge between the Zustand editor store and the shared Y.Doc.
//
// Model: object-per-key, last-writer-wins per entity. Far simpler than
// field-level CRDT and the pragmatic standard for this app shape — two users
// editing different clips merge; the same clip resolves to the last writer.
//
// Loop guard: our own writes are tagged with LOCAL_ORIGIN and skipped by the
// doc→store observer; while we apply a remote change, `isApplyingRemote`
// suppresses the store→doc subscription so nothing bounces back.

let isApplyingRemote = false;

function jsonEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Mirror the entire current store content into the doc (used to seed a host). */
export function pushAllToDoc(maps: CollabMaps): void {
  const s = useEditor.getState();
  maps.project.doc!.transact(() => {
    maps.project.set("data", s.project);
    maps.project.set("trackOrder", s.tracks.map((t) => t.id));
    reconcileRecord(maps.clips, s.clips);
    reconcileList(maps.media, Object.fromEntries(s.media.map((m) => [m.id, m])));
    reconcileList(maps.tracks, Object.fromEntries(s.tracks.map((t) => [t.id, t])));
  }, LOCAL_ORIGIN);
}

function reconcileRecord<T extends { id: string }>(
  map: Y.Map<unknown>,
  record: Record<string, T>,
): void {
  const seen = new Set<string>();
  for (const [id, value] of Object.entries(record)) {
    seen.add(id);
    if (!jsonEq(map.get(id), value)) map.set(id, value);
  }
  for (const id of [...map.keys()]) if (!seen.has(id)) map.delete(id);
}

function reconcileList(map: Y.Map<unknown>, byId: Record<string, unknown>): void {
  reconcileRecord(map, byId as Record<string, { id: string }>);
}

// ── store → doc ──────────────────────────────────────────────────────────────

function pushChangesToDoc(maps: CollabMaps): void {
  const s = useEditor.getState();
  maps.project.doc!.transact(() => {
    if (!jsonEq(maps.project.get("data"), s.project)) maps.project.set("data", s.project);
    const order = s.tracks.map((t) => t.id);
    if (!jsonEq(maps.project.get("trackOrder"), order)) maps.project.set("trackOrder", order);
    reconcileRecord(maps.clips, s.clips);
    reconcileList(maps.media, Object.fromEntries(s.media.map((m) => [m.id, m])));
    reconcileList(maps.tracks, Object.fromEntries(s.tracks.map((t) => [t.id, t])));
  }, LOCAL_ORIGIN);
}

// ── doc → store ──────────────────────────────────────────────────────────────

function rebuildStoreFromDoc(maps: CollabMaps): boolean {
  const project = maps.project.get("data") as ProjectMeta | undefined;
  if (!project) return false; // doc not seeded yet — nothing to adopt

  const order = (maps.project.get("trackOrder") as string[] | undefined) ?? [];
  const clips = normalizeClips(Object.fromEntries(maps.clips.entries()) as Record<string, Clip>);
  const media = [...maps.media.values()] as MediaItem[];

  const tracksById = new Map<string, Track>();
  for (const [id, t] of maps.tracks.entries()) tracksById.set(id, t as Track);
  const tracks: Track[] = [];
  for (const id of order) {
    const t = tracksById.get(id);
    if (t) {
      tracks.push(t);
      tracksById.delete(id);
    }
  }
  for (const t of tracksById.values()) tracks.push(t); // any not in the order list

  isApplyingRemote = true;
  try {
    // Drop selections that point at clips that no longer exist remotely.
    const selectedClipIds = useEditor
      .getState()
      .selectedClipIds.filter((id) => clips[id]);
    useEditor.setState({ project, media, tracks, clips, selectedClipIds });
  } finally {
    isApplyingRemote = false;
  }
  return true;
}

/**
 * Wire both directions. `seedFromStore` true = this peer seeds the doc with its
 * current project and contributes immediately (the one who Starts a session).
 * false = wait to adopt remote state before contributing (the one who Joins);
 * call the returned `enableLocal()` as a fallback if joining an empty room.
 */
export function bindEditorToDoc(
  maps: CollabMaps,
  seedFromStore: boolean,
): { unbind: () => void; enableLocal: () => void } {
  let localEnabled = seedFromStore;

  if (seedFromStore) pushAllToDoc(maps);

  // store → doc: only on content-slice changes, never while applying remote.
  const unsubStore = useEditor.subscribe((s, prev) => {
    if (isApplyingRemote || !localEnabled) return;
    const changed =
      s.tracks !== prev.tracks ||
      s.clips !== prev.clips ||
      s.media !== prev.media ||
      s.project !== prev.project;
    if (changed) pushChangesToDoc(maps);
  });

  // doc → store: rebuild on any remote change (skip our own LOCAL_ORIGIN writes).
  const onChange = (_e: unknown, tx: Y.Transaction) => {
    if (tx.origin === LOCAL_ORIGIN) return;
    const adopted = rebuildStoreFromDoc(maps);
    if (adopted && !localEnabled) localEnabled = true; // joiner: adopt then contribute
  };
  maps.project.observeDeep(onChange);
  maps.media.observeDeep(onChange);
  maps.tracks.observeDeep(onChange);
  maps.clips.observeDeep(onChange);

  // Adopt whatever is already in the doc at bind time (joiner arriving mid-session).
  if (!seedFromStore) {
    const adopted = rebuildStoreFromDoc(maps);
    if (adopted) localEnabled = true;
  }

  return {
    unbind: () => {
      unsubStore();
      maps.project.unobserveDeep(onChange);
      maps.media.unobserveDeep(onChange);
      maps.tracks.unobserveDeep(onChange);
      maps.clips.unobserveDeep(onChange);
    },
    enableLocal: () => {
      if (localEnabled) return;
      localEnabled = true;
      pushAllToDoc(maps); // seed the empty room we joined
    },
  };
}

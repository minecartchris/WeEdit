import { create } from "zustand";
import {
  KEYFRAME_EPSILON,
  clampClipStart,
  isMediaCompatibleWithTrack,
  resolveTransform,
} from "@/lib/clips";
import type {
  AspectRatio,
  Clip,
  Keyframe,
  LibraryFilter,
  MediaClip,
  MediaItem,
  ProjectMeta,
  TextClip,
  Track,
  TrackKind,
  Transform,
} from "@/types";

// Phase 1.5 store: clip ops, drag sessions, and a small undo/redo history layer.
//
// History model: each user-visible mutation calls `withHistory()` which snapshots
// {tracks, clips, media, project, selectedClipIds} into `past` and clears `future`.
// Long-running interactions (drag/trim) call `pushHistory()` once at session start
// and then mutate freely with `updateClip()` (which doesn't touch history).

type Snapshot = Pick<EditorState, "tracks" | "clips" | "media" | "project" | "selectedClipIds">;

const HISTORY_LIMIT = 100;

function snapshot(s: EditorState): Snapshot {
  return {
    tracks: s.tracks,
    clips: s.clips,
    media: s.media,
    project: s.project,
    selectedClipIds: s.selectedClipIds,
  };
}

function withHistory<T extends object>(
  s: EditorState,
  patch: T,
): T & { past: Snapshot[]; future: Snapshot[] } {
  return {
    ...patch,
    past: [...s.past.slice(-(HISTORY_LIMIT - 1)), snapshot(s)],
    future: [],
  };
}

interface EditorState {
  project: ProjectMeta;
  media: MediaItem[];
  tracks: Track[];
  clips: Record<string, Clip>;

  /** Current playhead in seconds. */
  playheadSec: number;
  isPlaying: boolean;

  /** Selected clip ids. */
  selectedClipIds: string[];

  /** Timeline horizontal zoom — pixels per second. */
  pxPerSec: number;

  /** Which sidebar bucket is selected — drives the library view. */
  libraryFilter: LibraryFilter;

  /** Active library-to-timeline drag session (set by media card, cleared on end/drop). */
  dragSession: { mediaId: string; kind: MediaItem["kind"] } | null;

  /** Track currently under the drag cursor — drives the lane hover highlight. */
  hoverTrackId: string | null;

  /** Path to the on-disk .weedit project folder (null until first save / open). */
  projectPath: string | null;

  /** Timestamp of last successful save (or load). null if never saved. */
  lastSavedAt: number | null;

  past: Snapshot[];
  future: Snapshot[];

  // ── Playhead / playback / zoom / selection (transient — no history)
  setPlayhead: (sec: number) => void;
  togglePlay: () => void;
  setZoom: (pxPerSec: number) => void;
  selectClip: (id: string | null, additive?: boolean) => void;
  clearSelection: () => void;

  // ── Library
  setLibraryFilter: (key: LibraryFilter) => void;
  addMedia: (item: MediaItem) => void;
  removeMedia: (id: string) => void;
  setMediaAudioTrackMuted: (mediaId: string, trackIndex: number, muted: boolean) => void;

  // ── Project
  setProjectAspect: (aspect: AspectRatio) => void;
  setProjectName: (name: string) => void;

  // ── Tracks
  addTrack: (kind: TrackKind) => string;
  removeTrack: (id: string) => void;
  renameTrack: (id: string, name: string) => void;
  setTrackVolume: (id: string, volume: number) => void;
  setTrackMuted: (id: string, muted: boolean) => void;
  /** Move a track up/down its render order among same-kind tracks (z-index). */
  moveTrackLayer: (id: string, direction: "up" | "down") => void;

  // ── Clips
  addClip: (clip: Clip) => void;
  removeClip: (id: string) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  /** Move a clip to another track (and set its start). No history — used
   *  during a drag; caller snapshots once at gesture start. */
  moveClipToTrack: (clipId: string, newTrackId: string, startSec: number) => void;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;

  // ── Clipboard
  /** Clips copied with copySelectedClips, ready to paste. */
  clipboard: Clip[];
  copySelectedClips: () => void;
  pasteClips: () => void;
  /** Split a video clip's audio onto a new audio track and mute the video. */
  detachAudio: (clipId: string) => void;

  // ── Transform / keyframes (visible clips)
  /** Apply a transform patch: edits the keyframe at the playhead if the clip is
   *  animated, otherwise the static transform. No history (callers snapshot). */
  setTransformAtPlayhead: (clipId: string, patch: Partial<Transform>) => void;
  addKeyframeAtPlayhead: (clipId: string) => void;
  removeKeyframe: (clipId: string, index: number) => void;
  clearKeyframes: (clipId: string) => void;

  // ── Drag session (library → timeline)
  beginDragSession: (mediaId: string, kind: MediaItem["kind"]) => void;
  endDragSession: () => void;
  setHoverTrackId: (id: string | null) => void;

  // ── Project persistence
  setProjectPath: (path: string | null) => void;
  setLastSavedAt: (t: number | null) => void;
  applyLoadedProject: (
    data: {
      project: ProjectMeta;
      media: MediaItem[];
      tracks: Track[];
      clips: Record<string, Clip>;
    },
    path: string,
    savedAt: number,
  ) => void;
  resetProject: () => void;

  // ── History
  pushHistory: () => void;
  undo: () => void;
  redo: () => void;
}

const ASPECT_DIMENSIONS: Record<AspectRatio, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1":  { width: 1080, height: 1080 },
  "4:3":  { width: 1440, height: 1080 },
  "21:9": { width: 2560, height: 1080 },
};

const defaultProject = (): ProjectMeta => ({
  name: "My Project",
  aspectRatio: "16:9",
  fps: 30,
  width: 1920,
  height: 1080,
  createdAt: Date.now(),
  updatedAt: Date.now(),
});

// Text 1 is intentionally NOT in the defaults — it confused beta testers ("why
// is there a text track if I don't use text?"). `TextPanel` auto-creates one
// the first time the user clicks a text preset.
const defaultTracks = (): Track[] => [
  { id: "track-video-1", kind: "video", name: "Video 1", volume: 1, muted: false, zIndex: 20, clipIds: [] },
  { id: "track-audio-1", kind: "audio", name: "Audio 1", volume: 1, muted: false, zIndex: 10, clipIds: [] },
];

function nextTrackName(existing: Track[], kind: TrackKind): string {
  const prefix = kind === "video" ? "Video" : kind === "audio" ? "Audio" : "Text";
  const taken = new Set(existing.filter((t) => t.kind === kind).map((t) => t.name));
  for (let i = 1; i < 999; i++) {
    const candidate = `${prefix} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix} ${existing.length + 1}`;
}

function nextZIndex(existing: Track[], kind: TrackKind): number {
  const base = kind === "text" ? 30 : kind === "video" ? 20 : 10;
  const peer = existing.filter((t) => t.kind === kind).map((t) => t.zIndex);
  return peer.length ? Math.max(...peer) + 1 : base;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: defaultProject(),
  media: [],
  tracks: defaultTracks(),
  clips: {},
  playheadSec: 0,
  isPlaying: false,
  selectedClipIds: [],
  pxPerSec: 8,
  libraryFilter: "project-bin",
  dragSession: null,
  hoverTrackId: null,
  projectPath: null,
  lastSavedAt: null,
  clipboard: [],
  past: [],
  future: [],

  // Transient
  setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setZoom: (pxPerSec) => set({ pxPerSec: Math.max(0.05, Math.min(200, pxPerSec)) }),
  selectClip: (id, additive = false) =>
    set((s) => {
      if (id == null) return { selectedClipIds: [] };
      if (additive) {
        return s.selectedClipIds.includes(id)
          ? { selectedClipIds: s.selectedClipIds.filter((x) => x !== id) }
          : { selectedClipIds: [...s.selectedClipIds, id] };
      }
      return { selectedClipIds: [id] };
    }),
  clearSelection: () => set({ selectedClipIds: [] }),

  // Library
  setLibraryFilter: (key) => set({ libraryFilter: key }),
  addMedia: (item) => set((s) => withHistory(s, { media: [...s.media, item] })),
  removeMedia: (id) =>
    set((s) =>
      withHistory(s, {
        media: s.media.filter((m) => m.id !== id),
      }),
    ),
  setMediaAudioTrackMuted: (mediaId, trackIndex, muted) =>
    set((s) => ({
      media: s.media.map((m) => {
        if (m.id !== mediaId || !m.audioTracks) return m;
        return {
          ...m,
          audioTracks: m.audioTracks.map((t) =>
            t.index === trackIndex ? { ...t, muted } : t,
          ),
        };
      }),
    })),

  // Project
  setProjectAspect: (aspect) =>
    set((s) =>
      withHistory(s, {
        project: {
          ...s.project,
          aspectRatio: aspect,
          ...ASPECT_DIMENSIONS[aspect],
          updatedAt: Date.now(),
        },
      }),
    ),
  setProjectName: (name) =>
    set((s) =>
      withHistory(s, {
        project: { ...s.project, name, updatedAt: Date.now() },
      }),
    ),

  // Tracks
  addTrack: (kind) => {
    const id = `track-${kind}-${crypto.randomUUID().slice(0, 8)}`;
    set((s) =>
      withHistory(s, {
        tracks: [
          ...s.tracks,
          {
            id,
            kind,
            name: nextTrackName(s.tracks, kind),
            volume: 1,
            muted: false,
            zIndex: nextZIndex(s.tracks, kind),
            clipIds: [],
          },
        ],
      }),
    );
    return id;
  },
  removeTrack: (id) =>
    set((s) => {
      const track = s.tracks.find((t) => t.id === id);
      if (!track) return s;
      // Remove the track and any clips that lived on it.
      const removedClipIds = new Set(track.clipIds);
      const newClips = { ...s.clips };
      for (const cid of removedClipIds) delete newClips[cid];
      return withHistory(s, {
        tracks: s.tracks.filter((t) => t.id !== id),
        clips: newClips,
        selectedClipIds: s.selectedClipIds.filter((cid) => !removedClipIds.has(cid)),
      });
    }),
  renameTrack: (id, name) =>
    set((s) =>
      withHistory(s, {
        tracks: s.tracks.map((t) => (t.id === id ? { ...t, name } : t)),
      }),
    ),
  // Volume + mute mutate without history. Phase 2: capture history at slider
  // mousedown so a single drag = one undo entry.
  setTrackVolume: (id, volume) =>
    set((s) => ({
      tracks: s.tracks.map((t) =>
        t.id === id ? { ...t, volume: Math.max(0, Math.min(1, volume)) } : t,
      ),
    })),
  setTrackMuted: (id, muted) =>
    set((s) => ({
      tracks: s.tracks.map((t) => (t.id === id ? { ...t, muted } : t)),
    })),
  // Reorder a track within its same-kind stack by swapping zIndex with the
  // neighbour. "up" = a higher layer (renders on top). PreviewStage picks the
  // active video from the highest-zIndex video track down.
  moveTrackLayer: (id, direction) =>
    set((s) => {
      const track = s.tracks.find((t) => t.id === id);
      if (!track) return s;
      const peers = s.tracks
        .filter((t) => t.kind === track.kind)
        .sort((a, b) => a.zIndex - b.zIndex);
      const idx = peers.findIndex((t) => t.id === id);
      const swapIdx = direction === "up" ? idx + 1 : idx - 1;
      if (swapIdx < 0 || swapIdx >= peers.length) return s;
      const other = peers[swapIdx];
      return withHistory(s, {
        tracks: s.tracks.map((t) =>
          t.id === track.id
            ? { ...t, zIndex: other.zIndex }
            : t.id === other.id
            ? { ...t, zIndex: track.zIndex }
            : t,
        ),
      });
    }),

  // Clips
  addClip: (clip) =>
    set((s) =>
      withHistory(s, {
        clips: { ...s.clips, [clip.id]: clip },
        tracks: s.tracks.map((t) =>
          t.id === clip.trackId ? { ...t, clipIds: [...t.clipIds, clip.id] } : t,
        ),
        selectedClipIds: [clip.id],
      }),
    ),
  removeClip: (id) =>
    set((s) => {
      const clip = s.clips[id];
      if (!clip) return s;
      const newClips = { ...s.clips };
      delete newClips[id];
      return withHistory(s, {
        clips: newClips,
        tracks: s.tracks.map((t) =>
          t.id === clip.trackId
            ? { ...t, clipIds: t.clipIds.filter((cid) => cid !== id) }
            : t,
        ),
        selectedClipIds: s.selectedClipIds.filter((cid) => cid !== id),
      });
    }),
  // No history — used for live drag/trim/slider updates.
  updateClip: (id, patch) =>
    set((s) => {
      const existing = s.clips[id];
      if (!existing) return s;
      return { clips: { ...s.clips, [id]: { ...existing, ...patch } as Clip } };
    }),
  moveClipToTrack: (clipId, newTrackId, startSec) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip) return s;
      if (clip.trackId === newTrackId) {
        return { clips: { ...s.clips, [clipId]: { ...clip, startSec } as Clip } };
      }
      const tracks = s.tracks.map((t) => {
        if (t.id === clip.trackId) return { ...t, clipIds: t.clipIds.filter((c) => c !== clipId) };
        if (t.id === newTrackId) return { ...t, clipIds: [...t.clipIds, clipId] };
        return t;
      });
      return {
        tracks,
        clips: { ...s.clips, [clipId]: { ...clip, trackId: newTrackId, startSec } as Clip },
      };
    }),
  splitAtPlayhead: () =>
    set((s) => {
      const t = s.playheadSec;
      const isUnder = (c: Clip) => c.startSec < t && t < c.startSec + c.durationSec;
      // Prefer splitting selected clips the playhead actually passes through;
      // otherwise act as a razor on whatever clip(s) sit under the playhead.
      const selectedUnder = s.selectedClipIds.filter((id) => {
        const c = s.clips[id];
        return c && isUnder(c);
      });
      const targetIds =
        selectedUnder.length > 0
          ? selectedUnder
          : Object.values(s.clips).filter(isUnder).map((c) => c.id);
      if (targetIds.length === 0) return s;

      const newClips: Record<string, Clip> = { ...s.clips };
      const trackAdditions: Record<string, string[]> = {};
      const newSelection: string[] = [];

      for (const id of targetIds) {
        const clip = newClips[id];
        if (!clip) continue;
        const offset = t - clip.startSec;
        if (offset <= 0 || offset >= clip.durationSec) continue;

        const left = { ...clip, durationSec: offset };
        const rightId = crypto.randomUUID();
        const right = {
          ...clip,
          id: rightId,
          startSec: t,
          durationSec: clip.durationSec - offset,
          sourceInSec: clip.sourceInSec + offset,
        };
        newClips[id] = left as Clip;
        newClips[rightId] = right as Clip;
        (trackAdditions[clip.trackId] ??= []).push(rightId);
        newSelection.push(id, rightId);
      }
      if (newSelection.length === 0) return s;

      return withHistory(s, {
        clips: newClips,
        tracks: s.tracks.map((tr) =>
          trackAdditions[tr.id]
            ? { ...tr, clipIds: [...tr.clipIds, ...trackAdditions[tr.id]] }
            : tr,
        ),
        selectedClipIds: newSelection,
      });
    }),
  deleteSelected: () =>
    set((s) => {
      const ids = s.selectedClipIds;
      if (ids.length === 0) return s;
      const removed = new Set(ids);
      const newClips = { ...s.clips };
      for (const id of ids) delete newClips[id];
      return withHistory(s, {
        clips: newClips,
        tracks: s.tracks.map((t) => ({
          ...t,
          clipIds: t.clipIds.filter((cid) => !removed.has(cid)),
        })),
        selectedClipIds: [],
      });
    }),

  // Clipboard. Copy deep-clones the current selection; paste lays them down at
  // the playhead preserving their relative offsets, on the original track when
  // it still fits else the first compatible one, clamped to avoid overlap.
  copySelectedClips: () =>
    set((s) => ({
      clipboard: s.selectedClipIds
        .map((id) => s.clips[id])
        .filter((c): c is Clip => Boolean(c))
        .map((c) => ({ ...c })),
    })),
  pasteClips: () =>
    set((s) => {
      if (s.clipboard.length === 0) return s;
      const minStart = Math.min(...s.clipboard.map((c) => c.startSec));
      const compatible = (c: Clip) => (t: Track) =>
        c.kind === "text" ? t.kind === "text" : isMediaCompatibleWithTrack(c.kind, t);

      const newClips: Record<string, Clip> = { ...s.clips };
      const trackAdds: Record<string, string[]> = {};
      const newSelection: string[] = [];

      for (const c of s.clipboard) {
        const fits = compatible(c);
        const orig = s.tracks.find((t) => t.id === c.trackId);
        const target = orig && fits(orig) ? orig : s.tracks.find(fits);
        if (!target) continue;
        const id = crypto.randomUUID();
        const desiredStart = Math.max(0, s.playheadSec + (c.startSec - minStart));
        const start = clampClipStart(id, target.id, c.durationSec, desiredStart, desiredStart, newClips);
        newClips[id] = { ...c, id, trackId: target.id, startSec: start } as Clip;
        (trackAdds[target.id] ??= []).push(id);
        newSelection.push(id);
      }
      if (newSelection.length === 0) return s;
      return withHistory(s, {
        clips: newClips,
        tracks: s.tracks.map((t) =>
          trackAdds[t.id] ? { ...t, clipIds: [...t.clipIds, ...trackAdds[t.id]] } : t,
        ),
        selectedClipIds: newSelection,
      });
    }),

  detachAudio: (clipId) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind !== "video") return s;
      // Put the detached audio on its own new audio track so it can never
      // collide with existing audio clips, and the user can move it freely.
      const trackId = `track-audio-${crypto.randomUUID().slice(0, 8)}`;
      const audioClipId = crypto.randomUUID();
      const audioClip: Clip = {
        id: audioClipId,
        trackId,
        startSec: clip.startSec,
        durationSec: clip.durationSec,
        sourceInSec: clip.sourceInSec,
        kind: "audio",
        mediaId: clip.mediaId,
        opacity: 1,
        volume: clip.volume > 0 ? clip.volume : 1,
        xPct: 50,
        yPct: 50,
        scale: 1,
      };
      const newTrack: Track = {
        id: trackId,
        kind: "audio",
        name: nextTrackName(s.tracks, "audio"),
        volume: 1,
        muted: false,
        zIndex: nextZIndex(s.tracks, "audio"),
        clipIds: [audioClipId],
      };
      return withHistory(s, {
        tracks: [...s.tracks, newTrack],
        clips: {
          ...s.clips,
          [audioClipId]: audioClip,
          // Mute the source video's audio — its sound now lives on the new track.
          [clipId]: { ...clip, volume: 0 } as Clip,
        },
        selectedClipIds: [audioClipId],
      });
    }),

  // Transform / keyframes
  setTransformAtPlayhead: (clipId, patch) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "audio") return s;
      const vc = clip as MediaClip | TextClip;
      const kfs = vc.keyframes;
      if (!kfs || kfs.length === 0) {
        return { clips: { ...s.clips, [clipId]: { ...vc, ...patch } as Clip } };
      }
      const t = Math.max(0, Math.min(vc.durationSec, s.playheadSec - vc.startSec));
      const cur = resolveTransform(vc, s.playheadSec);
      const merged = {
        xPct: patch.xPct ?? cur.xPct,
        yPct: patch.yPct ?? cur.yPct,
        scale: patch.scale ?? cur.scale,
      };
      const idx = kfs.findIndex((k) => Math.abs(k.tSec - t) <= KEYFRAME_EPSILON);
      const keyframes =
        idx >= 0
          ? kfs.map((k, i) => (i === idx ? { ...k, ...merged } : k))
          : [...kfs, { tSec: t, ...merged }].sort((a, b) => a.tSec - b.tSec);
      return { clips: { ...s.clips, [clipId]: { ...vc, keyframes } as Clip } };
    }),
  addKeyframeAtPlayhead: (clipId) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "audio") return s;
      const vc = clip as MediaClip | TextClip;
      const t = Math.max(0, Math.min(vc.durationSec, s.playheadSec - vc.startSec));
      const cur = resolveTransform(vc, s.playheadSec);
      const kf: Keyframe = { tSec: t, xPct: cur.xPct, yPct: cur.yPct, scale: cur.scale };
      const existing = (vc.keyframes ?? []).filter((k) => Math.abs(k.tSec - t) > KEYFRAME_EPSILON);
      const keyframes = [...existing, kf].sort((a, b) => a.tSec - b.tSec);
      return withHistory(s, { clips: { ...s.clips, [clipId]: { ...vc, keyframes } as Clip } });
    }),
  removeKeyframe: (clipId, index) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "audio") return s;
      const vc = clip as MediaClip | TextClip;
      if (!vc.keyframes) return s;
      const next = vc.keyframes.filter((_, i) => i !== index);
      return withHistory(s, {
        clips: { ...s.clips, [clipId]: { ...vc, keyframes: next.length ? next : undefined } as Clip },
      });
    }),
  clearKeyframes: (clipId) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "audio") return s;
      const vc = clip as MediaClip | TextClip;
      return withHistory(s, { clips: { ...s.clips, [clipId]: { ...vc, keyframes: undefined } as Clip } });
    }),

  // Drag session
  beginDragSession: (mediaId, kind) => set({ dragSession: { mediaId, kind } }),
  endDragSession: () => set({ dragSession: null, hoverTrackId: null }),
  setHoverTrackId: (id) => set({ hoverTrackId: id }),

  // Project persistence
  setProjectPath: (path) => set({ projectPath: path }),
  setLastSavedAt: (t) => set({ lastSavedAt: t }),
  applyLoadedProject: (data, path, savedAt) =>
    set({
      project: data.project,
      media: data.media,
      tracks: data.tracks,
      clips: data.clips,
      projectPath: path,
      lastSavedAt: savedAt,
      selectedClipIds: [],
      playheadSec: 0,
      isPlaying: false,
      clipboard: [],
      past: [],
      future: [],
    }),
  resetProject: () =>
    set({
      project: defaultProject(),
      media: [],
      tracks: defaultTracks(),
      clips: {},
      projectPath: null,
      lastSavedAt: null,
      selectedClipIds: [],
      playheadSec: 0,
      isPlaying: false,
      clipboard: [],
      past: [],
      future: [],
    }),

  // History
  pushHistory: () =>
    set((s) => ({
      past: [...s.past.slice(-(HISTORY_LIMIT - 1)), snapshot(s)],
      future: [],
    })),
  undo: () => {
    const s = get();
    if (s.past.length === 0) return;
    const previous = s.past[s.past.length - 1];
    set({
      ...previous,
      past: s.past.slice(0, -1),
      future: [snapshot(s), ...s.future.slice(0, HISTORY_LIMIT - 1)],
    });
  },
  redo: () => {
    const s = get();
    if (s.future.length === 0) return;
    const next = s.future[0];
    set({
      ...next,
      past: [...s.past.slice(-(HISTORY_LIMIT - 1)), snapshot(s)],
      future: s.future.slice(1),
    });
  },
}));

// ── Helpers used by UI ──────────────────────────────────────────────────────
//
// NOTE: don't write Zustand selectors that return freshly-built arrays/objects
// (e.g. `s.selectedClipIds.map(id => s.clips[id])`) — useSyncExternalStore
// requires snapshot stability. Either compose with `useMemo` in the component
// against raw state slices, or read a single stable value (one clip, a boolean,
// a length) directly inside the selector.

export function formatTimecode(totalSec: number, fps = 30): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) totalSec = 0;
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const f = Math.floor((totalSec - Math.floor(totalSec)) * fps);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

export function formatDuration(totalSec: number | undefined): string {
  if (totalSec == null || !Number.isFinite(totalSec)) return "—";
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = Math.floor(totalSec % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

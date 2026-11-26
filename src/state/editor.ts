import { create } from "zustand";
import { MAX_VOLUME } from "@/lib/audioGain";
import {
  KEYFRAME_EPSILON,
  MAX_CLIP_SPEED,
  MIN_CLIP_DURATION,
  MIN_CLIP_SPEED,
  autoTrackLabel,
  clampClipStart,
  gapAt,
  groupMoveWindow,
  isMediaCompatibleWithTrack,
  isVisualTrack,
  resolveTransform,
  resolveVolume,
  uniqueTrackName,
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
  VolumeKeyframe,
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
  /** Preview-only playback rate for skimming (0.1x-4x). Not saved, not exported. */
  previewRate: number;

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
  setPreviewRate: (rate: number) => void;
  /** Step the preview rate by `delta` (e.g. ±0.1), rounded to one decimal. */
  nudgePreviewRate: (delta: number) => void;
  setZoom: (pxPerSec: number) => void;
  selectClip: (id: string | null, additive?: boolean) => void;
  /** Replace the selection with `ids` (or add them to it when `additive`). */
  selectClips: (ids: string[], additive?: boolean) => void;
  clearSelection: () => void;

  // ── Library
  setLibraryFilter: (key: LibraryFilter) => void;
  addMedia: (item: MediaItem) => void;
  removeMedia: (id: string) => void;
  /** Point an existing media item at a re-imported file (same id, so every
   *  clip that uses it follows). Used by "Replace file…" for moved media. */
  relinkMedia: (id: string, next: MediaItem) => void;
  setMediaAudioTrackMuted: (mediaId: string, trackIndex: number, muted: boolean) => void;
  /** Name one audio stream of a media item ("" clears it). Auto-label uses it (#52). */
  setMediaAudioTrackName: (mediaId: string, trackIndex: number, name: string) => void;

  // ── Project
  setProjectAspect: (aspect: AspectRatio) => void;
  setProjectName: (name: string) => void;

  // ── Tracks
  addTrack: (kind: TrackKind) => string;
  removeTrack: (id: string) => void;
  renameTrack: (id: string, name: string) => void;
  /**
   * Name audio tracks after the audio on them (stream title, else language,
   * else the source file). Pass a track id for just that one, or nothing for
   * every audio track. Returns how many were renamed.
   */
  autoLabelAudioTracks: (trackId?: string) => number;
  setTrackVolume: (id: string, volume: number) => void;
  setTrackMuted: (id: string, muted: boolean) => void;
  /** Move a track up/down its render order among same-kind tracks (z-index). */
  moveTrackLayer: (id: string, direction: "up" | "down") => void;
  /** Reorder a track up/down in the timeline list. Swaps with its neighbour;
   *  when two video tracks swap, their z-index swaps too so the preview's
   *  compositing order matches the new visual order. */
  moveTrack: (id: string, direction: "up" | "down") => void;

  // ── Clips
  addClip: (clip: Clip) => void;
  /** Add many clips (onto existing tracks) as one undo step. */
  insertClips: (clips: Clip[]) => void;
  addMarker: (sec: number, label?: string, color?: string) => string;
  addMarkers: (markers: Array<{ sec: number; label: string; color?: string }>) => void;
  renameMarker: (id: string, label: string) => void;
  removeMarker: (id: string) => void;
  clearMarkers: () => void;
  /**
   * Remove timeline time ranges `[start, end)` from EVERY track and close them
   * up (ripple), so everything after each range moves left and stays in sync.
   * Clips spanning a range are split around it. One undo step.
   */
  rippleDeleteRanges: (ranges: Array<[number, number]>) => void;
  removeClip: (id: string) => void;
  updateClip: (id: string, patch: Partial<Clip>) => void;
  /** Patch several clips in one store write — one re-render per drag frame. */
  updateClips: (patches: Record<string, Partial<Clip>>) => void;
  /** Move a clip to another track (and set its start). No history — used
   *  during a drag; caller snapshots once at gesture start. */
  moveClipToTrack: (clipId: string, newTrackId: string, startSec: number) => void;
  splitAtPlayhead: () => void;
  deleteSelected: () => void;
  /** Slide clips left/right as far as they go without overlapping anything,
   *  keeping their relative offsets — like dragging them into a neighbour (#48). */
  pushClips: (ids: string[], direction: "left" | "right") => void;
  /** Ripple-delete the empty gap on a track at `atSec`: every clip after it
   *  shifts left by the gap's length (#48). */
  closeGap: (trackId: string, atSec: number) => void;

  // ── Clipboard
  /** Clips copied with copySelectedClips, ready to paste. */
  clipboard: Clip[];
  /** The media the copied clips use — carried along for pasting into another project. */
  clipboardMedia: MediaItem[];
  /** The tracks the copied clips sat on (kind + name), for recreating them elsewhere. */
  clipboardTracks: { id: string; kind: TrackKind; name: string }[];
  /** True once a different project has been opened since the copy. */
  clipboardForeign: boolean;
  copySelectedClips: () => void;
  pasteClips: () => void;
  /** Split a video clip's audio onto a new audio track and mute the video. */
  detachAudio: (clipId: string) => void;
  /** Set a media clip's playback speed (rescales its timeline duration to keep
   *  the same source span, clamped so it doesn't overlap the next clip). */
  setClipSpeed: (clipId: string, speed: number) => void;

  // ── Transform / keyframes (visible clips)
  /** Apply a transform patch: edits the keyframe at the playhead if the clip is
   *  animated, otherwise the static transform. No history (callers snapshot). */
  setTransformAtPlayhead: (clipId: string, patch: Partial<Transform>) => void;
  addKeyframeAtPlayhead: (clipId: string) => void;
  removeKeyframe: (clipId: string, index: number) => void;
  clearKeyframes: (clipId: string) => void;
  // ── Volume keyframes (audio + video clips)
  /** Set the volume: edits the keyframe at the playhead once the clip has any. */
  setVolumeAtPlayhead: (clipId: string, volume: number) => void;
  addVolumeKeyframeAtPlayhead: (clipId: string) => void;
  removeVolumeKeyframe: (clipId: string, index: number) => void;
  clearVolumeKeyframes: (clipId: string) => void;

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

const TRACK_PREFIX: Record<TrackKind, string> = {
  video: "Video",
  image: "Image",
  audio: "Audio",
  text: "Text",
};

function nextTrackName(existing: Track[], kind: TrackKind): string {
  const prefix = TRACK_PREFIX[kind];
  const taken = new Set(existing.filter((t) => t.kind === kind).map((t) => t.name));
  for (let i = 1; i < 999; i++) {
    const candidate = `${prefix} ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix} ${existing.length + 1}`;
}

function nextZIndex(existing: Track[], kind: TrackKind): number {
  const base = kind === "text" ? 30 : kind === "audio" ? 10 : 20;
  // Video and image tracks composite in one stack, so a new one of either
  // lands above every existing visual layer.
  const visual = kind === "video" || kind === "image";
  const peer = existing
    .filter((t) => (visual ? isVisualTrack(t) : t.kind === kind))
    .map((t) => t.zIndex);
  return peer.length ? Math.max(...peer) + 1 : base;
}

export const useEditor = create<EditorState>((set, get) => ({
  project: defaultProject(),
  media: [],
  tracks: defaultTracks(),
  clips: {},
  playheadSec: 0,
  isPlaying: false,
  previewRate: 1,
  selectedClipIds: [],
  pxPerSec: 8,
  libraryFilter: "backgrounds",
  dragSession: null,
  hoverTrackId: null,
  projectPath: null,
  lastSavedAt: null,
  clipboard: [],
  clipboardMedia: [],
  clipboardTracks: [],
  clipboardForeign: false,
  past: [],
  future: [],

  // Transient
  setPlayhead: (sec) => set({ playheadSec: Math.max(0, sec) }),
  togglePlay: () => set((s) => ({ isPlaying: !s.isPlaying })),
  setPreviewRate: (rate) =>
    set({ previewRate: Number.isFinite(rate) ? Math.max(0.1, Math.min(4, rate)) : 1 }),
  nudgePreviewRate: (delta) =>
    set((s) => {
      // Round to the 0.1 grid so a rate the slider left at e.g. 0.37 steps
      // to 0.5 / 0.3 rather than 0.47 / 0.27.
      const next = Math.round((s.previewRate + delta) * 10) / 10;
      return { previewRate: Math.max(0.1, Math.min(4, next)) };
    }),
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
  selectClips: (ids, additive = false) =>
    set((s) => ({
      selectedClipIds: additive ? [...new Set([...s.selectedClipIds, ...ids])] : [...new Set(ids)],
    })),
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
  relinkMedia: (id, next) =>
    set((s) =>
      withHistory(s, {
        media: s.media.map((m) =>
          m.id === id
            ? {
                ...next,
                id,
                importedAt: m.importedAt,
                // Media-level mute flags survive the relink, matched by stream index.
                audioTracks: next.audioTracks?.map((t) => ({
                  ...t,
                  muted: m.audioTracks?.find((o) => o.index === t.index)?.muted ?? t.muted,
                  name: m.audioTracks?.find((o) => o.index === t.index)?.name ?? t.name,
                })),
              }
            : m,
        ),
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

  setMediaAudioTrackName: (mediaId, trackIndex, name) =>
    set((s) =>
      withHistory(s, {
        media: s.media.map((m) => {
          if (m.id !== mediaId || !m.audioTracks) return m;
          return {
            ...m,
            audioTracks: m.audioTracks.map((t) =>
              t.index === trackIndex ? { ...t, name: name.trim() || undefined } : t,
            ),
          };
        }),
      }),
    ),

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
    set((s) => {
      const track: Track = {
        id,
        kind,
        name: nextTrackName(s.tracks, kind),
        volume: 1,
        muted: false,
        zIndex: nextZIndex(s.tracks, kind),
        clipIds: [],
      };
      // Insertion order in the timeline list (#49): audio goes to the very
      // bottom; video, image and text go to the very top — text above the
      // video it captions, and either way you always know where a new track
      // landed.
      const tracks = kind === "audio" ? [...s.tracks, track] : [track, ...s.tracks];
      return withHistory(s, { tracks });
    });
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
  autoLabelAudioTracks: (trackId) => {
    let renamed = 0;
    set((s) => {
      const targets = s.tracks.filter(
        (t) => t.kind === "audio" && (trackId == null || t.id === trackId),
      );
      if (targets.length === 0) return s;

      // Tracks we're not touching keep their names, so a generated one never
      // collides with a name the user typed themselves.
      const targetIds = new Set(targets.map((t) => t.id));
      const taken = new Set(s.tracks.filter((t) => !targetIds.has(t.id)).map((t) => t.name));

      const next = new Map<string, string>();
      for (const t of targets) {
        const label = autoTrackLabel(t, s.clips, s.media);
        // Nothing to go on (empty track, missing media) — leave it alone rather
        // than renaming it to something arbitrary.
        if (!label) {
          taken.add(t.name);
          continue;
        }
        const name = uniqueTrackName(label, taken);
        taken.add(name);
        if (name !== t.name) next.set(t.id, name);
      }

      renamed = next.size;
      if (renamed === 0) return s;
      return withHistory(s, {
        tracks: s.tracks.map((t) => (next.has(t.id) ? { ...t, name: next.get(t.id)! } : t)),
      });
    });
    return renamed;
  },
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
        // Allow boost above unity (up to MAX_VOLUME); preview applies the extra
        // gain via a Web Audio node since element.volume is capped at 1.0.
        t.id === id ? { ...t, volume: Math.max(0, Math.min(MAX_VOLUME, volume)) } : t,
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
  moveTrack: (id, direction) =>
    set((s) => {
      const idx = s.tracks.findIndex((t) => t.id === id);
      if (idx < 0) return s;
      const swapIdx = direction === "up" ? idx - 1 : idx + 1;
      if (swapIdx < 0 || swapIdx >= s.tracks.length) return s;
      const a = s.tracks[idx];
      const b = s.tracks[swapIdx];
      const tracks = [...s.tracks];
      if (isVisualTrack(a) && isVisualTrack(b)) {
        // Swap z-index too so "higher in the list" stays "renders on top".
        tracks[idx] = { ...b, zIndex: a.zIndex };
        tracks[swapIdx] = { ...a, zIndex: b.zIndex };
      } else {
        tracks[idx] = b;
        tracks[swapIdx] = a;
      }
      return withHistory(s, { tracks });
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
  // No history either — the caller pushes once at the start of a drag.
  updateClips: (patches) =>
    set((s) => {
      const clips = { ...s.clips };
      let touched = false;
      for (const [id, patch] of Object.entries(patches)) {
        const existing = clips[id];
        if (!existing) continue;
        clips[id] = { ...existing, ...patch } as Clip;
        touched = true;
      }
      return touched ? { clips } : s;
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
  addMarker: (sec, label, color) => {
    const id = crypto.randomUUID();
    set((s) => {
      const existing = s.project.markers ?? [];
      const marker = { id, sec: Math.max(0, sec), label: label ?? `Marker ${existing.length + 1}`, color };
      const markers = [...existing, marker].sort((a, b) => a.sec - b.sec);
      return withHistory(s, { project: { ...s.project, markers } });
    });
    return id;
  },
  addMarkers: (list) =>
    set((s) => {
      if (list.length === 0) return s;
      const markers = [
        ...(s.project.markers ?? []),
        ...list.map((m) => ({ id: crypto.randomUUID(), sec: Math.max(0, m.sec), label: m.label, color: m.color })),
      ].sort((a, b) => a.sec - b.sec);
      return withHistory(s, { project: { ...s.project, markers } });
    }),
  renameMarker: (id, label) =>
    set((s) =>
      withHistory(s, {
        project: {
          ...s.project,
          markers: (s.project.markers ?? []).map((m) => (m.id === id ? { ...m, label } : m)),
        },
      }),
    ),
  removeMarker: (id) =>
    set((s) =>
      withHistory(s, {
        project: { ...s.project, markers: (s.project.markers ?? []).filter((m) => m.id !== id) },
      }),
    ),
  clearMarkers: () => set((s) => withHistory(s, { project: { ...s.project, markers: [] } })),
  insertClips: (newClips) =>
    set((s) => {
      if (newClips.length === 0) return s;
      const clips = { ...s.clips };
      const adds: Record<string, string[]> = {};
      for (const c of newClips) {
        clips[c.id] = c;
        (adds[c.trackId] ??= []).push(c.id);
      }
      return withHistory(s, {
        clips,
        tracks: s.tracks.map((t) => (adds[t.id] ? { ...t, clipIds: [...t.clipIds, ...adds[t.id]] } : t)),
      });
    }),
  rippleDeleteRanges: (input) =>
    set((s) => {
      const EPS = 1e-3;
      // Merge overlaps, then work from the END of the timeline backwards so a
      // range's ripple never moves a range still to be processed.
      const sorted = input
        .filter(([a, b]) => b - a > EPS)
        .map(([a, b]) => [Math.max(0, a), b] as [number, number])
        .sort((x, y) => x[0] - y[0]);
      const merged: Array<[number, number]> = [];
      for (const r of sorted) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
        else merged.push([r[0], r[1]]);
      }
      if (merged.length === 0) return s;

      const shiftKeys = <K extends { tSec: number }>(keys: K[] | undefined, by: number) =>
        keys?.map((k) => ({ ...k, tSec: k.tSec - by })).filter((k) => k.tSec >= 0);
      // The part of `c` that starts `off` seconds in, placed at `at`, `dur` long.
      const tail = (c: Clip, id: string, off: number, at: number, dur: number): Clip => {
        const speed = c.kind === "text" ? 1 : (c as MediaClip).speed ?? 1;
        const out = {
          ...c,
          id,
          startSec: at,
          durationSec: dur,
          sourceInSec: c.sourceInSec + off * speed,
          keyframes: shiftKeys(c.keyframes, off),
          transition: undefined,
        } as Clip;
        if (c.kind !== "text") {
          (out as MediaClip).volumeKeyframes = shiftKeys((c as MediaClip).volumeKeyframes, off);
        }
        return out;
      };

      const clips: Record<string, Clip> = { ...s.clips };
      const adds: Record<string, string[]> = {};
      const removed = new Set<string>();
      for (const [a, b] of merged.reverse()) {
        const cut = b - a;
        for (const c of Object.values(clips)) {
          const start = c.startSec;
          const end = c.startSec + c.durationSec;
          if (end <= a + EPS) continue; // entirely before the range
          if (start >= b - EPS) {
            clips[c.id] = { ...c, startSec: start - cut } as Clip; // after: ripple left
            continue;
          }
          const leftDur = a - start;
          const rightDur = end - b;
          if (leftDur > EPS && rightDur > EPS) {
            clips[c.id] = { ...c, durationSec: leftDur } as Clip;
            const id = crypto.randomUUID();
            clips[id] = tail(c, id, b - start, a, rightDur);
            (adds[c.trackId] ??= []).push(id);
          } else if (leftDur > EPS) {
            clips[c.id] = { ...c, durationSec: leftDur } as Clip;
          } else if (rightDur > EPS) {
            clips[c.id] = tail(c, c.id, b - start, a, rightDur);
          } else {
            delete clips[c.id];
            removed.add(c.id);
          }
        }
      }
      return withHistory(s, {
        clips,
        tracks: s.tracks.map((t) => ({
          ...t,
          clipIds: [...t.clipIds.filter((id) => !removed.has(id)), ...(adds[t.id] ?? [])],
        })),
        selectedClipIds: [],
      });
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

        // Source consumed by the left part scales with speed.
        const speed = clip.kind === "text" ? 1 : (clip as MediaClip).speed ?? 1;
        const left = { ...clip, durationSec: offset };
        const rightId = crypto.randomUUID();
        const right = {
          ...clip,
          id: rightId,
          startSec: t,
          durationSec: clip.durationSec - offset,
          sourceInSec: clip.sourceInSec + offset * speed,
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

  pushClips: (ids, direction) =>
    set((s) => {
      const live = ids.filter((id) => s.clips[id]);
      if (live.length === 0) return s;
      const win = groupMoveWindow(live, s.clips);
      const d = direction === "left" ? win.min : win.max;
      if (!Number.isFinite(d) || Math.abs(d) < 1e-6) return s;
      const clips = { ...s.clips };
      for (const id of live) {
        clips[id] = { ...clips[id], startSec: Math.max(0, clips[id].startSec + d) } as Clip;
      }
      return withHistory(s, { clips });
    }),
  closeGap: (trackId, atSec) =>
    set((s) => {
      const gap = gapAt(trackId, atSec, s.clips);
      if (!gap) return s;
      const shift = gap.endSec - gap.startSec;
      const clips = { ...s.clips };
      for (const c of Object.values(s.clips)) {
        if (c.trackId === trackId && c.startSec >= gap.endSec - 1e-6) {
          clips[c.id] = { ...c, startSec: Math.max(0, c.startSec - shift) } as Clip;
        }
      }
      return withHistory(s, { clips });
    }),

  // Clipboard. Copy deep-clones the current selection along with the media and
  // tracks it came from, so it survives opening another project (#51).
  //  - Same project: paste lays the clips down at the playhead keeping their
  //    relative offsets, on the original track when it still fits else the
  //    first compatible one, clamped to avoid overlap.
  //  - Another project: the clips' media is brought along, and they land on
  //    brand-new tracks at the top of the timeline (one per source track, in
  //    the source order) so nothing in the open project gets disturbed.
  copySelectedClips: () =>
    set((s) => {
      const clips = s.selectedClipIds
        .map((id) => s.clips[id])
        .filter((c): c is Clip => Boolean(c))
        .map((c) => ({ ...c }));
      if (clips.length === 0) return s;
      const mediaIds = new Set(clips.flatMap((c) => (c.kind === "text" ? [] : [(c as MediaClip).mediaId])));
      const trackIds = new Set(clips.map((c) => c.trackId));
      return {
        clipboard: clips,
        clipboardMedia: s.media.filter((m) => mediaIds.has(m.id)),
        clipboardTracks: s.tracks
          .filter((t) => trackIds.has(t.id))
          .map((t) => ({ id: t.id, kind: t.kind, name: t.name })),
        clipboardForeign: false,
      };
    }),
  pasteClips: () =>
    set((s) => {
      if (s.clipboard.length === 0) return s;
      const minStart = Math.min(...s.clipboard.map((c) => c.startSec));
      const startFor = (c: Clip) => Math.max(0, s.playheadSec + (c.startSec - minStart));

      if (s.clipboardForeign) {
        // Bring the media along. Reuse this project's copy when it already has
        // the same file (by id, else by path) so the bin doesn't fill with dupes.
        const media = [...s.media];
        const mediaRemap = new Map<string, string>();
        for (const m of s.clipboardMedia) {
          const existing = media.find((mm) => mm.id === m.id) ?? media.find((mm) => mm.src === m.src);
          if (existing) {
            mediaRemap.set(m.id, existing.id);
          } else {
            media.push({ ...m });
            mediaRemap.set(m.id, m.id);
          }
        }

        // One fresh track per source track, stacked at the top in source order.
        const taken = new Set(s.tracks.map((t) => t.name));
        let zTracks = [...s.tracks];
        const trackRemap = new Map<string, Track>();
        for (const src of s.clipboardTracks) {
          const id = `track-${src.kind}-${crypto.randomUUID().slice(0, 8)}`;
          const name = uniqueTrackName(src.name, taken);
          taken.add(name);
          const track: Track = {
            id,
            kind: src.kind,
            name,
            volume: 1,
            muted: false,
            zIndex: nextZIndex(zTracks, src.kind),
            clipIds: [],
          };
          zTracks = [...zTracks, track];
          trackRemap.set(src.id, track);
        }

        const newClips: Record<string, Clip> = { ...s.clips };
        const newSelection: string[] = [];
        for (const c of s.clipboard) {
          const target = trackRemap.get(c.trackId);
          if (!target) continue;
          const id = crypto.randomUUID();
          const next = { ...c, id, trackId: target.id, startSec: startFor(c) } as Clip;
          if (next.kind !== "text") {
            const mid = mediaRemap.get((next as MediaClip).mediaId);
            if (!mid) continue;
            (next as MediaClip).mediaId = mid;
          }
          newClips[id] = next;
          target.clipIds.push(id);
          newSelection.push(id);
        }
        if (newSelection.length === 0) return s;
        const added = s.clipboardTracks
          .map((t) => trackRemap.get(t.id)!)
          .filter((t) => t.clipIds.length > 0);
        return withHistory(s, {
          media,
          clips: newClips,
          tracks: [...added, ...s.tracks],
          selectedClipIds: newSelection,
        });
      }

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
        const desiredStart = startFor(c);
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
        // Keep the source timing and per-stream mutes so the detached audio
        // stays in sync and still exposes every audio track of the source.
        speed: clip.speed,
        pitchPreserved: clip.pitchPreserved,
        mutedTracks: clip.mutedTracks,
        xPct: 50,
        yPct: 50,
        scale: 1,
        rotation: 0,
        tilt: 0,
      };
      // Name it after the audio it holds right away — this is where the
      // "Audio 1/2/3" pile-up comes from, and the metadata is already here.
      const detachedLabel = autoTrackLabel(
        { id: trackId, kind: "audio", name: "", volume: 1, muted: false, zIndex: 0, clipIds: [audioClipId] },
        { ...s.clips, [audioClipId]: audioClip },
        s.media,
      );
      const newTrack: Track = {
        id: trackId,
        kind: "audio",
        name: detachedLabel
          ? uniqueTrackName(detachedLabel, new Set(s.tracks.map((t) => t.name)))
          : nextTrackName(s.tracks, "audio"),
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

  setClipSpeed: (clipId, speed) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "text") return s;
      const mc = clip as MediaClip;
      const sp = Math.max(MIN_CLIP_SPEED, Math.min(MAX_CLIP_SPEED, speed));
      const sourceSpan = mc.durationSec * (mc.speed ?? 1);
      let newDur = sourceSpan / sp;
      // Slowing down lengthens the clip — clamp so it can't cover the next clip
      // on the same track.
      let maxDur = Infinity;
      for (const other of Object.values(s.clips)) {
        if (other.id === clipId || other.trackId !== mc.trackId) continue;
        if (other.startSec >= mc.startSec + 1e-6) {
          maxDur = Math.min(maxDur, other.startSec - mc.startSec);
        }
      }
      const clampedDur = Math.max(MIN_CLIP_DURATION, Math.min(maxDur, newDur));
      // If the neighbor/min-duration clamp kicked in, `clampedDur` no longer
      // matches `sp` under the sourceSpan = durationSec * speed invariant.
      // Storing the requested `sp` anyway would silently shrink the source
      // span this clip thinks it covers, and that corrupted (smaller) span
      // becomes the basis for the *next* speed change — so a clip that gets
      // clamped once during a gradual edit (e.g. holding the speed field's
      // up arrow, one small step at a time) permanently drifts to a shorter
      // duration than a clip of the same source nudged there in one jump,
      // even though both were set to the same target speed. Re-derive the
      // effective speed from the clamped duration instead, so the invariant
      // — and therefore the true source span — always holds.
      const effectiveSpeed =
        clampedDur === newDur ? sp : Math.max(MIN_CLIP_SPEED, Math.min(MAX_CLIP_SPEED, sourceSpan / clampedDur));
      // No history here — like updateClip, the slider snapshots once on mousedown
      // so a whole speed drag collapses into a single undo entry.
      return {
        clips: {
          ...s.clips,
          [clipId]: { ...mc, speed: effectiveSpeed, durationSec: clampedDur } as Clip,
        },
      };
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
        rotation: patch.rotation ?? cur.rotation,
        tilt: patch.tilt ?? cur.tilt,
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
      const kf: Keyframe = {
        tSec: t,
        xPct: cur.xPct,
        yPct: cur.yPct,
        scale: cur.scale,
        rotation: cur.rotation,
        tilt: cur.tilt,
      };
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

  // Volume keyframes. Mirrors the transform keyframe actions: once a clip has
  // any, the static `volume` is no longer what plays, so edits must land in the
  // keyframe at the playhead instead of silently diverging from the preview.
  setVolumeAtPlayhead: (clipId, volume) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "text") return s;
      const mc = clip as MediaClip;
      const v = Math.max(0, Math.min(MAX_VOLUME, volume));
      const kfs = mc.volumeKeyframes;
      if (!kfs || kfs.length === 0) {
        return { clips: { ...s.clips, [clipId]: { ...mc, volume: v } as Clip } };
      }
      const t = Math.max(0, Math.min(mc.durationSec, s.playheadSec - mc.startSec));
      const idx = kfs.findIndex((k) => Math.abs(k.tSec - t) <= KEYFRAME_EPSILON);
      const volumeKeyframes =
        idx >= 0
          ? kfs.map((k, i) => (i === idx ? { ...k, volume: v } : k))
          : [...kfs, { tSec: t, volume: v }].sort((a, b) => a.tSec - b.tSec);
      return { clips: { ...s.clips, [clipId]: { ...mc, volumeKeyframes } as Clip } };
    }),
  addVolumeKeyframeAtPlayhead: (clipId) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "text") return s;
      const mc = clip as MediaClip;
      const t = Math.max(0, Math.min(mc.durationSec, s.playheadSec - mc.startSec));
      const kf: VolumeKeyframe = { tSec: t, volume: resolveVolume(mc, s.playheadSec) };
      const existing = (mc.volumeKeyframes ?? []).filter(
        (k) => Math.abs(k.tSec - t) > KEYFRAME_EPSILON,
      );
      const volumeKeyframes = [...existing, kf].sort((a, b) => a.tSec - b.tSec);
      return withHistory(s, {
        clips: { ...s.clips, [clipId]: { ...mc, volumeKeyframes } as Clip },
      });
    }),
  removeVolumeKeyframe: (clipId, index) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "text") return s;
      const mc = clip as MediaClip;
      if (!mc.volumeKeyframes) return s;
      const next = mc.volumeKeyframes.filter((_, i) => i !== index);
      // Dropping to a single keyframe would animate nothing; dropping to none
      // hands playback back to the static `volume`, so carry the last value
      // over rather than silently jumping back to the pre-keyframe level.
      const volume = next.length === 0 ? mc.volumeKeyframes[0].volume : mc.volume;
      return withHistory(s, {
        clips: {
          ...s.clips,
          [clipId]: {
            ...mc,
            volume,
            volumeKeyframes: next.length ? next : undefined,
          } as Clip,
        },
      });
    }),
  clearVolumeKeyframes: (clipId) =>
    set((s) => {
      const clip = s.clips[clipId];
      if (!clip || clip.kind === "text") return s;
      const mc = clip as MediaClip;
      const volume = mc.volumeKeyframes?.length ? mc.volumeKeyframes[0].volume : mc.volume;
      return withHistory(s, {
        clips: { ...s.clips, [clipId]: { ...mc, volume, volumeKeyframes: undefined } as Clip },
      });
    }),

  // Drag session
  beginDragSession: (mediaId, kind) => set({ dragSession: { mediaId, kind } }),
  endDragSession: () => set({ dragSession: null, hoverTrackId: null }),
  setHoverTrackId: (id) => set({ hoverTrackId: id }),

  // Project persistence
  setProjectPath: (path) => set({ projectPath: path }),
  setLastSavedAt: (t) => set({ lastSavedAt: t }),
  applyLoadedProject: (data, path, savedAt) =>
    set((s) => ({
      project: data.project,
      media: data.media,
      tracks: data.tracks,
      clips: data.clips,
      projectPath: path,
      lastSavedAt: savedAt,
      selectedClipIds: [],
      playheadSec: 0,
      isPlaying: false,
      // The clipboard outlives the project so clips can be pasted into the
      // next one (#51). Restoring a version of the same project keeps it local.
      clipboardForeign: s.clipboardForeign || path !== s.projectPath,
      past: [],
      future: [],
    })),
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
      // The clipboard outlives the project so clips can be pasted into the
      // next one (#51); it just no longer refers to this project's tracks.
      clipboardForeign: true,
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

// Domain types for the editor. Phase 0 stubs the shape so components can be
// typed end-to-end; Phase 1 fills in real behavior (clip splitting, ranges, etc.).

export type MediaKind = "video" | "image" | "audio";

export interface AudioTrackInfo {
  /** Index among audio streams (0, 1, 2…) — matches ffmpeg `-map 0:a:N`. */
  index: number;
  /** Codec name from ffprobe (e.g. "aac", "opus"). */
  codec?: string;
  /** Channel count from ffprobe. */
  channels?: number;
  /** ISO language tag (e.g. "eng", "jpn"). */
  language?: string;
  /** Stream-level title from ffprobe tags. */
  title?: string;
  /** Absolute path to the extracted single-stream audio file. */
  filepath: string;
  /** True if the user has muted this track for playback. */
  muted: boolean;
}

export interface MediaItem {
  id: string;
  name: string;
  kind: MediaKind;
  /** Absolute path on disk (or NAS URL once Phase 5 lands). */
  src: string;
  /** Source duration in seconds (videos / audio). */
  durationSec?: number;
  /** Source resolution (videos / images). */
  width?: number;
  height?: number;
  /** Thumbnail data URL or local path. Generated on import. */
  thumbnail?: string;
  /**
   * For videos with multiple audio streams, the per-stream extracted files
   * + mute state. When this is present, PreviewStage mutes the muxed video
   * audio and plays these tracks instead so the user can toggle each
   * independently. Undefined for single-audio videos and other media.
   */
  audioTracks?: AudioTrackInfo[];
  importedAt: number;
  /**
   * Content hash (streamed sha256) of the source file. The cross-peer identity
   * for collaboration: a collaborator matches this against files it already has
   * and fetches the bytes peer-to-peer when it doesn't. Computed lazily once a
   * session starts. Undefined for media that hasn't been hashed yet.
   */
  contentHash?: string;
  /** Source file size in bytes (transfer manifest / progress). */
  size?: number;
  /** Source file extension without the dot (e.g. "mp4") — names the cache file. */
  ext?: string;
}

export type TrackKind = "video" | "audio" | "text";

export interface Track {
  id: string;
  kind: TrackKind;
  /** Display label, e.g. "Video 1". */
  name: string;
  /** Per-track volume 0..1 (audio + video tracks only). */
  volume: number;
  muted: boolean;
  /** Render order. Lower = below in the visual stack. */
  zIndex: number;
  clipIds: string[];
}

/**
 * A single keyframe for animated transforms. `tSec` is relative to the clip
 * start. The preview interpolates xPct/yPct/scale/rotation/tilt linearly
 * between the surrounding keyframes; when a clip has no keyframes, its static
 * transform fields are used instead.
 */
export interface Keyframe {
  /** Time within the clip, in seconds from clip start. */
  tSec: number;
  xPct: number;
  yPct: number;
  scale: number;
  /** In-plane rotation in degrees (rotateZ). */
  rotation: number;
  /** 3D forward/back tilt in degrees (rotateX). */
  tilt: number;
}

/** Cross-clip transition types (blended over the incoming clip's lead-in). */
export type TransitionType = "crossfade" | "wipe";

export interface ClipTransition {
  type: TransitionType;
  /** Lead-in length in seconds — how long the blend with the previous clip lasts. */
  durationSec: number;
}

export interface ClipBase {
  id: string;
  trackId: string;
  /** Position on the timeline in seconds. */
  startSec: number;
  /** Duration on the timeline in seconds. */
  durationSec: number;
  /** Where in the source this clip starts (for trims), in seconds. */
  sourceInSec: number;
  /** Optional X/Y/Zoom/Rotation/Tilt keyframes, sorted by tSec. */
  keyframes?: Keyframe[];
  /**
   * Optional transition INTO this clip from the previous clip on the same
   * track. During the first `durationSec` the preview cross-renders the two.
   */
  transition?: ClipTransition;
}

/**
 * On-stage placement shared by visible clips (media + text). Center of the
 * element as a percentage of the stage (50/50 = centered); `scale` is a
 * multiplier (1 = natural size / object-contain fit).
 */
export interface Transform {
  xPct: number;
  yPct: number;
  scale: number;
  /** In-plane rotation in degrees (rotateZ). */
  rotation: number;
  /** 3D forward/back tilt in degrees (rotateX, with perspective). */
  tilt: number;
}

export interface MediaClip extends ClipBase, Transform {
  kind: "video" | "audio" | "image";
  mediaId: string;
  /** 0..1, applies to video/image. */
  opacity: number;
  /** 0..1, applies to video/audio. */
  volume: number;
  /**
   * Playback speed multiplier for video/audio (1 = normal, 2 = twice as fast,
   * 0.5 = half speed). Changing it rescales the clip's timeline duration. The
   * source span this clip covers is `durationSec * speed`. Undefined = 1.
   */
  speed?: number;
  /**
   * When speeding/slowing, keep the original pitch (true, default) or let the
   * pitch rise/fall with the speed like a tape (false).
   */
  pitchPreserved?: boolean;
  /**
   * Per-clip muted audio-stream indices (for multi-audio sources). Lives on the
   * clip — not the shared MediaItem — so two clips of the same media (e.g. a
   * copy/paste) can mute different streams independently.
   */
  mutedTracks?: number[];
}

export interface TextClip extends ClipBase, Transform {
  kind: "text";
  text: string;
  fontFamily: string;
  fontSizePx: number;
  color: string;
}

export type Clip = MediaClip | TextClip;

export type AspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "21:9";

export type LibraryFilter =
  | "project-bin"
  | "uploads"
  | "twitch"
  | "nas"
  | "exports"
  | "videos"
  | "images"
  | "audio"
  | "text"
  | "transitions"
  | "extras"
  | "backgrounds";

// ── UI preferences (app-global, not per-project) ────────────────────────────

export type ThemeMode = "light" | "dark" | "system";
/** How position values are shown/edited in the Inspector. */
export type PositionUnit = "percent" | "pixels";

export interface PanelSizes {
  /** Media library column width in px. */
  libraryPx: number;
  /** Inspector column width in px. */
  inspectorPx: number;
  /** Timeline panel height in px. */
  timelinePx: number;
}

/** Auto-save + automatic version-snapshot behavior (configurable in Settings). */
export interface AutosavePrefs {
  /** Master switch for the debounced disk auto-save. */
  enabled: boolean;
  /** How long to wait after the last edit before writing, in ms. */
  debounceMs: number;
  /** Whether auto-save also drops periodic version-history commits. */
  versionsEnabled: boolean;
  /** Minimum minutes between automatic version commits. */
  versionIntervalMin: number;
}

export interface UiPrefs {
  theme: ThemeMode;
  positionUnit: PositionUnit;
  /** Command id → key combo (e.g. "ctrl+shift+z"). Overrides defaults. */
  customShortcuts: Record<string, string>;
  panelSizes: PanelSizes;
  autosave: AutosavePrefs;
}

export interface ProjectMeta {
  name: string;
  aspectRatio: AspectRatio;
  /** Project frame rate. Used for snapping & export. */
  fps: number;
  /** Render canvas size in pixels. */
  width: number;
  height: number;
  createdAt: number;
  updatedAt: number;
}

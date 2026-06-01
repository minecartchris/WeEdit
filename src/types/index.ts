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

export interface ClipBase {
  id: string;
  trackId: string;
  /** Position on the timeline in seconds. */
  startSec: number;
  /** Duration on the timeline in seconds. */
  durationSec: number;
  /** Where in the source this clip starts (for trims), in seconds. */
  sourceInSec: number;
}

export interface MediaClip extends ClipBase {
  kind: "video" | "audio" | "image";
  mediaId: string;
  /** 0..1, applies to video/image. */
  opacity: number;
  /** 0..1, applies to video/audio. */
  volume: number;
}

export interface TextClip extends ClipBase {
  kind: "text";
  text: string;
  fontFamily: string;
  fontSizePx: number;
  color: string;
  xPct: number;
  yPct: number;
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

import type { Clip, MediaClip, MediaItem, TextClip, Track, Transform } from "@/types";

export const MIN_CLIP_DURATION = 0.1;
export const DEFAULT_IMAGE_DURATION = 5;
export const SNAP_PX = 6;
export const TEXT_CHAR_LIMIT = 200;

/** Min/max for the on-stage scale (zoom) multiplier. */
export const MIN_SCALE = 0.1;
export const MAX_SCALE = 4;

/**
 * Backfill transform fields on a clip loaded from disk. Projects saved before
 * positioning existed have no xPct/yPct/scale; default them to centered /
 * natural size so old projects open unchanged.
 */
export function normalizeClip(clip: Clip): Clip {
  const xPct = typeof clip.xPct === "number" ? clip.xPct : 50;
  const yPct = typeof clip.yPct === "number" ? clip.yPct : 50;
  const scale = typeof clip.scale === "number" ? clip.scale : 1;
  const rotation = typeof clip.rotation === "number" ? clip.rotation : 0;
  const tilt = typeof clip.tilt === "number" ? clip.tilt : 0;
  return { ...clip, xPct, yPct, scale, rotation, tilt } as Clip;
}

export function normalizeClips(
  clips: Record<string, Clip>,
): Record<string, Clip> {
  const out: Record<string, Clip> = {};
  for (const [id, c] of Object.entries(clips)) out[id] = normalizeClip(c);
  return out;
}

/** How close (seconds) a keyframe must be to the playhead to count as "here". */
export const KEYFRAME_EPSILON = 0.02;

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

/**
 * The effective transform of a clip at a given timeline time. With no keyframes
 * the static xPct/yPct/scale are used; otherwise the surrounding keyframes are
 * linearly interpolated (clamped to the first/last outside their range).
 */
/** The animated part of a transform (rotation/tilt are static, not keyframed). */
export type PositionScale = Pick<Transform, "xPct" | "yPct" | "scale">;

export function resolveTransform(clip: MediaClip | TextClip, playheadSec: number): PositionScale {
  const kfs = clip.keyframes;
  if (!kfs || kfs.length === 0) {
    return { xPct: clip.xPct, yPct: clip.yPct, scale: clip.scale };
  }
  const t = playheadSec - clip.startSec;
  if (t <= kfs[0].tSec) return pickTransform(kfs[0]);
  const last = kfs[kfs.length - 1];
  if (t >= last.tSec) return pickTransform(last);
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i];
    const b = kfs[i + 1];
    if (t >= a.tSec && t <= b.tSec) {
      const span = b.tSec - a.tSec || 1;
      const f = (t - a.tSec) / span;
      return {
        xPct: lerp(a.xPct, b.xPct, f),
        yPct: lerp(a.yPct, b.yPct, f),
        scale: lerp(a.scale, b.scale, f),
      };
    }
  }
  return pickTransform(last);
}

function pickTransform(t: PositionScale): PositionScale {
  return { xPct: t.xPct, yPct: t.yPct, scale: t.scale };
}

/** Convert a percentage (0..100) of a dimension to pixels, and back. */
export function pctToPx(pct: number, dimensionPx: number): number {
  return Math.round((pct / 100) * dimensionPx);
}
export function pxToPct(px: number, dimensionPx: number): number {
  if (dimensionPx <= 0) return 0;
  return (px / dimensionPx) * 100;
}

/** Which media kinds can land on a given track kind. */
export function isMediaCompatibleWithTrack(
  kind: MediaItem["kind"],
  track: Track,
): boolean {
  if (track.kind === "text")  return false;
  if (track.kind === "audio") return kind === "audio";
  if (track.kind === "video") return kind === "video" || kind === "image";
  return false;
}

/** Build a fresh MediaClip from a media item dropped onto a track at time t. */
export function makeClipFromMedia(
  media: MediaItem,
  trackId: string,
  startSec: number,
): MediaClip {
  const id = crypto.randomUUID();
  const durationSec =
    media.kind === "image"
      ? DEFAULT_IMAGE_DURATION
      : media.durationSec && media.durationSec > 0
      ? media.durationSec
      : DEFAULT_IMAGE_DURATION;
  return {
    id,
    trackId,
    startSec: Math.max(0, startSec),
    durationSec,
    sourceInSec: 0,
    kind: media.kind,
    mediaId: media.id,
    opacity: 1,
    volume: 1,
    xPct: 50,
    yPct: 50,
    scale: 1,
    rotation: 0,
    tilt: 0,
  };
}

/**
 * Snap a candidate timeline value (sec) to nearby anchors (other clip edges and
 * the playhead) when the screen-space distance is within SNAP_PX.
 */
export function snapToAnchors(
  candidateSec: number,
  anchorsSec: number[],
  pxPerSec: number,
): number {
  let best = candidateSec;
  let bestPx = SNAP_PX + 1;
  for (const a of anchorsSec) {
    const dPx = Math.abs((candidateSec - a) * pxPerSec);
    if (dPx <= SNAP_PX && dPx < bestPx) {
      best = a;
      bestPx = dPx;
    }
  }
  return best;
}

/** All clip edges except the given clip (so a moving clip doesn't snap to itself). */
export function clipEdgeAnchors(clips: Clip[], excludeId?: string): number[] {
  const out: number[] = [];
  for (const c of clips) {
    if (c.id === excludeId) continue;
    out.push(c.startSec, c.startSec + c.durationSec);
  }
  return out;
}

/**
 * Returns the half-open `[min, max]` start-second window that a clip can occupy
 * on its track without overlapping any other clip on the same track. `min` is
 * the right edge of the nearest clip-to-the-left (or 0); `max` is the left edge
 * of the nearest clip-to-the-right minus this clip's duration (or +Infinity).
 *
 * The window is anchored to `baseStartSec` — i.e. we walk neighbours relative
 * to the position the clip is currently in. This means a drag can't "jump
 * over" a neighbour: as soon as proposedStart hits the neighbour's edge, the
 * clamp pins it there.
 */
export interface NoOverlapWindow {
  min: number;
  max: number;
}
export function clipNoOverlapWindow(
  movingClipId: string,
  trackId: string,
  durationSec: number,
  baseStartSec: number,
  allClips: Record<string, Clip>,
): NoOverlapWindow {
  let min = 0;
  let max = Infinity;
  const baseEnd = baseStartSec + durationSec;
  for (const other of Object.values(allClips)) {
    if (other.id === movingClipId) continue;
    if (other.trackId !== trackId) continue;
    const otherEnd = other.startSec + other.durationSec;
    if (otherEnd <= baseStartSec) {
      // Neighbour to the left — its right edge is our lower bound.
      if (otherEnd > min) min = otherEnd;
    } else if (other.startSec >= baseEnd) {
      // Neighbour to the right — its left edge minus our duration is our upper bound.
      const candidateMax = other.startSec - durationSec;
      if (candidateMax < max) max = candidateMax;
    } else {
      // Already-overlapping (shouldn't happen if invariant holds, but be safe).
      if (other.startSec < baseStartSec) {
        if (otherEnd > min) min = otherEnd;
      } else {
        const candidateMax = other.startSec - durationSec;
        if (candidateMax < max) max = candidateMax;
      }
    }
  }
  return { min, max };
}

/** Clamp a proposed startSec into the no-overlap window. */
export function clampClipStart(
  movingClipId: string,
  trackId: string,
  durationSec: number,
  baseStartSec: number,
  proposedStart: number,
  allClips: Record<string, Clip>,
): number {
  const w = clipNoOverlapWindow(movingClipId, trackId, durationSec, baseStartSec, allClips);
  if (w.max < w.min) return baseStartSec; // pathologically tight — don't move
  return Math.max(w.min, Math.min(w.max, proposedStart));
}

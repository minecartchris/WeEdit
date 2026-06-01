import type { Clip, MediaClip, MediaItem, Track } from "@/types";

export const MIN_CLIP_DURATION = 0.1;
export const DEFAULT_IMAGE_DURATION = 5;
export const SNAP_PX = 6;
export const TEXT_CHAR_LIMIT = 200;

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

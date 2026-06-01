import type { Clip, MediaClip, MediaItem, Track } from "@/types";

export const MIN_CLIP_DURATION = 0.1;
export const DEFAULT_IMAGE_DURATION = 5;
export const SNAP_PX = 6;

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

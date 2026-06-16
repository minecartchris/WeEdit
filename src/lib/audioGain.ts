// Loudness for preview <video>/<audio> elements, including boost above 100%.
//
// HTMLMediaElement.volume is hard-capped at 1.0 by the browser, so to make a
// clip *louder* than its source we route the element through a Web Audio
// GainNode whose gain can exceed 1. That routing is only engaged when a clip is
// actually boosted (volume > 1): at or below unity we use the element's own
// `.volume`/`.muted` exactly as before, so the common path never touches Web
// Audio and can't regress normal playback.
//
// Once an element is routed it stays routed (createMediaElementSource can only
// be called once per element and permanently taps its output), so we keep a
// WeakMap of the gain nodes and drive everything through them thereafter.

/** Highest volume multiplier the UI allows (200% = +6 dB-ish boost). */
export const MAX_VOLUME = 2;

let ctx: AudioContext | null = null;
const gains = new WeakMap<HTMLMediaElement, GainNode>();

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

/** Routes `el` through a gain node (once) and returns it, or null if Web Audio
 *  is unavailable. Resumes a context the browser started suspended. */
function ensureGain(el: HTMLMediaElement): GainNode | null {
  const existing = gains.get(el);
  if (existing) {
    if (ctx && ctx.state === "suspended") void ctx.resume();
    return existing;
  }
  const c = getCtx();
  if (!c) return null;
  try {
    const source = c.createMediaElementSource(el);
    const gain = c.createGain();
    source.connect(gain);
    gain.connect(c.destination);
    gains.set(el, gain);
    if (c.state === "suspended") void c.resume();
    return gain;
  } catch {
    // Already connected elsewhere, or the element isn't eligible — fall back to
    // whatever (if anything) we already had for it.
    return gains.get(el) ?? null;
  }
}

/**
 * Applies a linear volume (0 = silent, 1 = unity, up to MAX_VOLUME = boost) to a
 * media element, choosing the native path for ≤ unity and a gain node above it.
 */
export function applyLoudness(el: HTMLMediaElement, volume: number): void {
  const v = Math.max(0, volume);
  const routed = gains.get(el);

  // Never-boosted element at/below unity: pure native path (unchanged behaviour).
  if (v <= 1 && !routed) {
    el.muted = v <= 0;
    el.volume = v;
    return;
  }

  const gain = ensureGain(el);
  if (!gain) {
    // Web Audio unavailable — best effort, capped at the element's native max.
    el.muted = v <= 0;
    el.volume = Math.min(1, v);
    return;
  }
  // Element plays at unity; the gain node carries the actual level (incl. mute).
  el.muted = false;
  el.volume = 1;
  gain.gain.value = v;
}

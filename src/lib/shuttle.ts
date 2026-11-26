import { useEditor } from "@/state/editor";
import type { Marker } from "@/types";

// J / K / L shuttle, the editor-standard transport:
//   L  play forward; press again for 2x, then 4x
//   K  stop (and reset the speed)
//   J  play backward; press again for 2x, then 4x
//
// Forward uses the normal playback loop with the preview rate. Media elements
// can't play in reverse, so backward moves the playhead on its own clock while
// the preview follows it frame by frame, like scrubbing.

const RATES = [1, 2, 4];
let reverseRaf = 0;
let reverseRate = 0;

function stopReverse(): void {
  if (reverseRaf) cancelAnimationFrame(reverseRaf);
  reverseRaf = 0;
  reverseRate = 0;
}

function nextRate(current: number): number {
  const i = RATES.indexOf(current);
  return i < 0 ? RATES[0] : RATES[Math.min(RATES.length - 1, i + 1)];
}

export function shuttleForward(): void {
  stopReverse();
  const ed = useEditor.getState();
  if (ed.isPlaying) {
    ed.setPreviewRate(nextRate(ed.previewRate));
  } else {
    ed.setPreviewRate(1);
    if (!ed.isPlaying) ed.togglePlay();
  }
}

export function shuttleStop(): void {
  stopReverse();
  const ed = useEditor.getState();
  if (ed.isPlaying) ed.togglePlay();
  ed.setPreviewRate(1);
}

export function shuttleBackward(): void {
  const ed = useEditor.getState();
  if (ed.isPlaying) ed.togglePlay();
  ed.setPreviewRate(1);
  reverseRate = reverseRate ? nextRate(reverseRate) : 1;
  if (reverseRaf) return; // already running; the new rate applies next frame
  let last: number | null = null;
  const tick = (now: number) => {
    if (last == null) last = now;
    const dt = (now - last) / 1000;
    last = now;
    const state = useEditor.getState();
    if (state.isPlaying) {
      stopReverse(); // forward playback took over
      return;
    }
    const next = state.playheadSec - dt * reverseRate;
    if (next <= 0) {
      state.setPlayhead(0);
      stopReverse();
      return;
    }
    state.setPlayhead(next);
    reverseRaf = requestAnimationFrame(tick);
  };
  reverseRaf = requestAnimationFrame(tick);
}

// ── Chapters ─────────────────────────────────────────────────────────────────

function chapterTime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/**
 * Markers as a YouTube chapter list ("0:00 Intro" per line). YouTube needs the
 * first chapter at 0:00, so one is added when the first marker is later.
 */
export function markersToChapters(markers: Marker[]): string {
  const sorted = [...markers].sort((a, b) => a.sec - b.sec);
  const lines = sorted.map((m) => `${chapterTime(m.sec)} ${m.label}`);
  if (sorted.length === 0 || sorted[0].sec >= 1) lines.unshift("0:00 Intro");
  return lines.join("\n");
}

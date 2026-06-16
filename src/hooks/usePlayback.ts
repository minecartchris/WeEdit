import { useEffect } from "react";
import { useEditor } from "@/state/editor";

// Drives the playhead while isPlaying is true. A rAF loop advances the playhead
// in real seconds and stops at the rightmost clip end so playback doesn't run
// off into empty timeline forever.
//
// We deliberately advance off the wall clock rather than reading a <video>
// element's currentTime: deriving the playhead from media made it jump
// backwards at clip boundaries (the outgoing clip's element is still "playing"
// for a frame), which read as a 1-2s stutter. The wall clock is monotonic, so
// the playhead is always smooth; each VideoLayer keeps its own element in sync
// with the playhead instead.
export function usePlayback() {
  const isPlaying = useEditor((s) => s.isPlaying);

  useEffect(() => {
    if (!isPlaying) return;

    let raf = 0;
    let last: number | null = null;

    const tick = (now: number) => {
      if (last == null) last = now;
      const dt = (now - last) / 1000;
      last = now;

      const state = useEditor.getState();

      // Total timeline duration so we can stop at the end.
      let totalDur = 0;
      for (const c of Object.values(state.clips)) {
        const end = c.startSec + c.durationSec;
        if (end > totalDur) totalDur = end;
      }

      const next = state.playheadSec + dt;
      if (totalDur > 0 && next >= totalDur) {
        state.setPlayhead(totalDur);
        // Stop at end. User can rewind / hit play again.
        useEditor.setState({ isPlaying: false });
        return;
      }

      state.setPlayhead(next);
      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [isPlaying]);
}

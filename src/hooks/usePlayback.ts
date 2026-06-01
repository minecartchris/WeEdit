import { useEffect } from "react";
import { useEditor } from "@/state/editor";

// Drives the playhead while isPlaying is true. A rAF loop advances playhead
// in real seconds; we stop at the rightmost clip end so playback doesn't run
// off into empty timeline forever. Phase 2 will swap to a media-clock-driven
// loop so video stays in lock-step with playhead even during seeking.
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

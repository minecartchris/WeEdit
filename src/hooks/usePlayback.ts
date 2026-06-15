import { useEffect } from "react";
import { useEditor } from "@/state/editor";

// Drives the playhead while isPlaying is true.
//
// Strategy: prefer a media-clock source to avoid wall-clock drift causing
// audio/video desync. On each rAF tick we look for a playing <video> element
// on the stage (the topmost VideoLayer) and derive the playhead from its
// currentTime + the clip's timeline offset. If no video is present (audio-only
// or image timeline) we fall back to the wall-clock dt path.
//
// This eliminates the up-to-500ms drift that accumulated when the rAF wall
// clock drifted from the browser's internal media clock.
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

      // Compute total timeline duration so we can stop at the end.
      let totalDur = 0;
      for (const c of Object.values(state.clips)) {
        const end = c.startSec + c.durationSec;
        if (end > totalDur) totalDur = end;
      }

      // Try to read playhead from a live <video> element (media-clock driven).
      // VideoLayer stamps each element with data-cliplayer="<clipId>", so we can
      // look up that clip's timeline offset and compute the true playhead.
      let nextFromMedia: number | null = null;
      // VideoLayer wraps each <video> inside a div[data-cliplayer], so find the
      // layer divs and read the <video> within.
      const layerDivs = document.querySelectorAll<HTMLElement>("[data-cliplayer]");
      for (const div of layerDivs) {
        const clipId = div.getAttribute("data-cliplayer");
        if (!clipId) continue;
        const clip = state.clips[clipId];
        if (!clip || clip.kind !== "video") continue;
        const videoEl = div.querySelector<HTMLVideoElement>("video");
        if (!videoEl || videoEl.paused || videoEl.readyState < 2) continue;
        const speed = (clip as import("@/types").MediaClip).speed ?? 1;
        // playheadSec = clip.startSec + (videoEl.currentTime - clip.sourceInSec) / speed
        const derived =
          (clip as import("@/types").MediaClip).startSec +
          (videoEl.currentTime - (clip as import("@/types").MediaClip).sourceInSec) / speed;
        if (Number.isFinite(derived) && derived >= 0) {
          nextFromMedia = derived;
          break;
        }
      }

      const next = nextFromMedia ?? state.playheadSec + dt;

      if (totalDur > 0 && next >= totalDur) {
        state.setPlayhead(totalDur);
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

import {
  ChevronDown,
  ChevronsLeft,
  ChevronsRight,
  Maximize,
  Pause,
  Play,
  SkipBack,
  SkipForward,
} from "lucide-react";
import { useRef } from "react";
import { PreviewStage } from "@/components/PreviewStage";
import { Menu, MenuItem, MenuLabel } from "@/components/ui/Menu";
import { useEditor } from "@/state/editor";
import type { AspectRatio } from "@/types";

const ASPECT_OPTIONS: AspectRatio[] = ["16:9", "9:16", "1:1", "4:3", "21:9"];

// Center-right panel: video stage + transport. PreviewStage now renders the
// active clip at the playhead; transport drives playhead via usePlayback.
export function Preview() {
  const isPlaying = useEditor((s) => s.isPlaying);
  const togglePlay = useEditor((s) => s.togglePlay);
  const aspect = useEditor((s) => s.project.aspectRatio);
  const setAspect = useEditor((s) => s.setProjectAspect);
  const setPlayhead = useEditor((s) => s.setPlayhead);

  // Fullscreen the stage area (the video, not the whole editor chrome).
  const stageAreaRef = useRef<HTMLDivElement>(null);
  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void stageAreaRef.current?.requestFullscreen().catch((err) => {
        console.error("Fullscreen failed:", err);
      });
    }
  };

  // SkipBack/SkipForward used to step a single frame, which was too tiny to
  // be useful. Now jump 5 seconds; arrow keys still step one frame for fine
  // alignment.
  const SKIP_SEC = 5;
  const skip = (dir: 1 | -1) => {
    const { playheadSec } = useEditor.getState();
    setPlayhead(Math.max(0, playheadSec + dir * SKIP_SEC));
  };

  const jumpToStart = () => setPlayhead(0);
  const jumpToEnd = () => {
    const { clips } = useEditor.getState();
    let max = 0;
    for (const c of Object.values(clips)) {
      const end = c.startSec + c.durationSec;
      if (end > max) max = end;
    }
    setPlayhead(max);
  };

  return (
    <section className="flex-1 min-w-0 flex flex-col bg-we-panel">
      <div
        ref={stageAreaRef}
        className="flex-1 min-h-0 grid place-items-center bg-we-stage relative overflow-hidden p-2"
        // Size container so the stage can fit itself to this area with cq units
        // (so e.g. 9:16 scales down to fit instead of running off-screen).
        style={{ containerType: "size" }}
      >
        <PreviewStage aspect={aspect} />
      </div>

      <PlayheadProgress />

      <div className="h-12 shrink-0 flex items-center px-3 border-t border-we-border bg-we-panel">
        <Menu
          dropUp
          trigger={({ onClick }) => (
            <button
              onClick={onClick}
              className="inline-flex items-center gap-1 px-2 py-1 rounded text-sm text-we-ink hover:bg-we-hover"
              title="Aspect ratio"
            >
              <span className="inline-block w-4 h-3 rounded-sm border border-we-muted" />
              {aspect}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
        >
          <MenuLabel>Aspect ratio</MenuLabel>
          {ASPECT_OPTIONS.map((opt) => (
            <MenuItem key={opt} onSelect={() => setAspect(opt)}>
              {opt}
              {opt === aspect && <span className="text-we-teal text-xs">·</span>}
            </MenuItem>
          ))}
        </Menu>

        <div className="flex-1 flex items-center justify-center gap-1">
          <button onClick={jumpToStart} className="we-btn-ghost p-2" title="Jump to start (Home)">
            <ChevronsLeft className="w-5 h-5" />
          </button>
          <button onClick={() => skip(-1)} className="we-btn-ghost p-2" title="Back 5 s (arrow keys step 1 frame)">
            <SkipBack className="w-5 h-5" />
          </button>
          <button
            onClick={togglePlay}
            className="we-btn-ghost p-2"
            title={isPlaying ? "Pause (Space)" : "Play (Space)"}
          >
            {isPlaying ? <Pause className="w-6 h-6" /> : <Play className="w-6 h-6" />}
          </button>
          <button onClick={() => skip(1)} className="we-btn-ghost p-2" title="Forward 5 s (arrow keys step 1 frame)">
            <SkipForward className="w-5 h-5" />
          </button>
          <button onClick={jumpToEnd} className="we-btn-ghost p-2" title="Jump to end (End)">
            <ChevronsRight className="w-5 h-5" />
          </button>
        </div>

        <button onClick={toggleFullscreen} className="we-btn-ghost p-2" title="Fullscreen">
          <Maximize className="w-5 h-5" />
        </button>
      </div>
    </section>
  );
}

// Slim progress bar above the transport showing playhead vs total duration.
function PlayheadProgress() {
  const playheadSec = useEditor((s) => s.playheadSec);
  const totalDur = useEditor((s) => {
    let max = 0;
    for (const c of Object.values(s.clips)) {
      const end = c.startSec + c.durationSec;
      if (end > max) max = end;
    }
    return max;
  });
  const pct = totalDur > 0 ? Math.min(100, (playheadSec / totalDur) * 100) : 0;
  return (
    <div className="h-1.5 bg-we-hover relative">
      <div className="absolute inset-y-0 left-0 bg-we-teal" style={{ width: `${pct}%` }} />
    </div>
  );
}

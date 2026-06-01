import { Music } from "lucide-react";
import { useCallback } from "react";
import {
  MIN_CLIP_DURATION,
  clipEdgeAnchors,
  snapToAnchors,
} from "@/lib/clips";
import { useEditor } from "@/state/editor";
import type { Clip, MediaClip, MediaItem, TextClip } from "@/types";

interface ClipBlockProps {
  clip: Clip;
  pxPerSec: number;
}

// One clip block on a timeline track. Handles selection click, body drag for
// repositioning, and edge handles for trimming.
export function ClipBlock({ clip, pxPerSec }: ClipBlockProps) {
  const isSelected = useEditor((s) => s.selectedClipIds.includes(clip.id));
  const selectClip = useEditor((s) => s.selectClip);
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const media = useEditor((s) => s.media);
  const allClips = useEditor((s) => s.clips);
  const playheadSec = useEditor((s) => s.playheadSec);

  const sourceMedia: MediaItem | undefined =
    clip.kind !== "text"
      ? media.find((m) => m.id === (clip as MediaClip).mediaId)
      : undefined;

  const collectAnchors = useCallback((): number[] => {
    const all = Object.values(allClips);
    return [...clipEdgeAnchors(all, clip.id), playheadSec, 0];
  }, [allClips, clip.id, playheadSec]);

  // ── Body drag (move along time axis) ──
  const onBodyMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectClip(clip.id, e.shiftKey);
    pushHistory();

    const startX = e.clientX;
    const initialStart = clip.startSec;
    const anchors = collectAnchors();

    const onMove = (ev: MouseEvent) => {
      const dPx = ev.clientX - startX;
      const dSec = dPx / pxPerSec;
      let nextStart = Math.max(0, initialStart + dSec);
      if (!ev.shiftKey) nextStart = snapToAnchors(nextStart, anchors, pxPerSec);
      updateClip(clip.id, { startSec: nextStart });
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // ── Edge trim ──
  const onTrimMouseDown = (edge: "left" | "right") => (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    selectClip(clip.id);
    pushHistory();

    const startX = e.clientX;
    const initial = {
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      sourceInSec: clip.sourceInSec,
    };
    const sourceDur =
      sourceMedia?.durationSec != null ? sourceMedia.durationSec : Infinity;
    const anchors = collectAnchors();

    const onMove = (ev: MouseEvent) => {
      const dSec = (ev.clientX - startX) / pxPerSec;
      if (edge === "left") {
        // Shift left edge by `dragged` seconds. Negative = extend leftward.
        const minDragged = Math.max(-initial.sourceInSec, -initial.startSec);
        const maxDragged = initial.durationSec - MIN_CLIP_DURATION;
        let dragged = Math.max(minDragged, Math.min(maxDragged, dSec));

        let nextStart = initial.startSec + dragged;
        if (!ev.shiftKey) {
          const snapped = snapToAnchors(nextStart, anchors, pxPerSec);
          dragged += snapped - nextStart;
          dragged = Math.max(minDragged, Math.min(maxDragged, dragged));
          nextStart = initial.startSec + dragged;
        }
        updateClip(clip.id, {
          startSec: nextStart,
          sourceInSec: initial.sourceInSec + dragged,
          durationSec: initial.durationSec - dragged,
        });
      } else {
        // Right edge: change durationSec; cap by source remaining.
        const maxDur = Math.max(MIN_CLIP_DURATION, sourceDur - initial.sourceInSec);
        let nextDur = Math.max(MIN_CLIP_DURATION, Math.min(maxDur, initial.durationSec + dSec));
        if (!ev.shiftKey) {
          const candidateEnd = initial.startSec + nextDur;
          const snapped = snapToAnchors(candidateEnd, anchors, pxPerSec);
          nextDur = Math.max(MIN_CLIP_DURATION, Math.min(maxDur, snapped - initial.startSec));
        }
        updateClip(clip.id, { durationSec: nextDur });
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  const left = clip.startSec * pxPerSec;
  const width = Math.max(2, clip.durationSec * pxPerSec);

  return (
    <div
      className={[
        "absolute top-1 bottom-1 rounded-md overflow-hidden flex select-none",
        isSelected ? "ring-2 ring-we-teal z-10" : "ring-1 ring-slate-300/80",
        clip.kind === "audio"
          ? "bg-emerald-100"
          : clip.kind === "text"
          ? "bg-amber-100"
          : "bg-slate-200",
      ].join(" ")}
      style={{ left, width }}
      onMouseDown={onBodyMouseDown}
      onClick={(e) => e.stopPropagation()}
      title={renderClipTitle(clip, sourceMedia)}
    >
      {/* Left trim handle */}
      <div
        onMouseDown={onTrimMouseDown("left")}
        className="w-1.5 shrink-0 bg-we-teal/60 hover:bg-we-teal cursor-ew-resize"
      />

      <div className="flex-1 min-w-0 relative cursor-grab active:cursor-grabbing">
        <ClipBackground clip={clip} sourceMedia={sourceMedia} width={width} />
        <ClipLabel clip={clip} sourceMedia={sourceMedia} />
      </div>

      {/* Right trim handle */}
      <div
        onMouseDown={onTrimMouseDown("right")}
        className="w-1.5 shrink-0 bg-we-teal/60 hover:bg-we-teal cursor-ew-resize"
      />
    </div>
  );
}

function ClipBackground({
  clip,
  sourceMedia,
  width,
}: {
  clip: Clip;
  sourceMedia: MediaItem | undefined;
  width: number;
}) {
  if (clip.kind === "audio") {
    return <AudioBars width={width} />;
  }
  if (clip.kind === "text") {
    return null;
  }
  if (sourceMedia?.thumbnail) {
    return (
      <div
        className="absolute inset-0 bg-cover bg-center bg-no-repeat opacity-90"
        style={{ backgroundImage: `url(${sourceMedia.thumbnail})` }}
      />
    );
  }
  return null;
}

function ClipLabel({
  clip,
  sourceMedia,
}: {
  clip: Clip;
  sourceMedia: MediaItem | undefined;
}) {
  if (clip.kind === "text") {
    const t = clip as TextClip;
    return (
      <div className="absolute inset-0 flex items-center px-2 text-xs text-amber-900 truncate">
        {t.text || "Text"}
      </div>
    );
  }
  if (clip.kind === "audio") {
    return (
      <div className="absolute inset-0 flex items-center gap-1 px-2 text-xs text-emerald-900 truncate">
        <Music className="w-3 h-3" />
        <span className="truncate">{sourceMedia?.name ?? "Audio"}</span>
      </div>
    );
  }
  return (
    <div className="absolute left-1.5 right-1.5 top-1 px-1 py-0.5 rounded bg-black/55 text-white text-[10px] truncate">
      {sourceMedia?.name ?? "Clip"}
    </div>
  );
}

function AudioBars({ width }: { width: number }) {
  // Cheap deterministic "waveform" so audio clips look distinct.
  const barCount = Math.max(8, Math.floor(width / 4));
  const heights: number[] = [];
  let seed = 1337;
  for (let i = 0; i < barCount; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    heights.push(0.25 + (seed / 233280) * 0.7);
  }
  return (
    <div className="absolute inset-0 flex items-end gap-px px-1 pb-1">
      {heights.map((h, i) => (
        <div
          key={i}
          className="flex-1 bg-emerald-500/60 rounded-sm"
          style={{ height: `${h * 100}%` }}
        />
      ))}
    </div>
  );
}

function renderClipTitle(clip: Clip, m: MediaItem | undefined): string {
  const name = clip.kind === "text" ? "Text" : m?.name ?? "Clip";
  return `${name} · ${clip.durationSec.toFixed(2)}s`;
}

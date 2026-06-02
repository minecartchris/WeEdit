import { MoreHorizontal, Music, Pencil, Scissors, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ContextMenu, ContextMenuItem } from "@/components/ui/ContextMenu";
import {
  MIN_CLIP_DURATION,
  TEXT_CHAR_LIMIT,
  clampClipStart,
  clipEdgeAnchors,
  clipNoOverlapWindow,
  snapToAnchors,
} from "@/lib/clips";
import { useEditor } from "@/state/editor";
import type { Clip, MediaClip, MediaItem, TextClip } from "@/types";

interface ClipBlockProps {
  clip: Clip;
  pxPerSec: number;
}

// One clip block on a timeline track. Handles selection click, body drag for
// repositioning, edge handles for trimming, double-click to edit text, and
// right-click for the per-clip context menu (delete / split / properties).
export function ClipBlock({ clip, pxPerSec }: ClipBlockProps) {
  const isSelected = useEditor((s) => s.selectedClipIds.includes(clip.id));
  const selectClip = useEditor((s) => s.selectClip);
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const removeClip = useEditor((s) => s.removeClip);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const media = useEditor((s) => s.media);
  const allClips = useEditor((s) => s.clips);
  const playheadSec = useEditor((s) => s.playheadSec);

  const [editingText, setEditingText] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

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
    if (editingText) return;
    if (e.button !== 0) return;
    e.stopPropagation();
    selectClip(clip.id, e.shiftKey);
    pushHistory();

    const startX = e.clientX;
    const initialStart = clip.startSec;
    const anchors = collectAnchors();
    const liveClips = useEditor.getState().clips;

    const onMove = (ev: MouseEvent) => {
      const dPx = ev.clientX - startX;
      const dSec = dPx / pxPerSec;
      let nextStart = Math.max(0, initialStart + dSec);
      if (!ev.shiftKey) nextStart = snapToAnchors(nextStart, anchors, pxPerSec);
      // No-overlap clamp against same-track neighbours.
      nextStart = clampClipStart(
        clip.id,
        clip.trackId,
        clip.durationSec,
        initialStart,
        nextStart,
        liveClips,
      );
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
    if (editingText) return;
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
    const window = clipNoOverlapWindow(
      clip.id,
      clip.trackId,
      initial.durationSec,
      initial.startSec,
      useEditor.getState().clips,
    );

    const onMove = (ev: MouseEvent) => {
      const dSec = (ev.clientX - startX) / pxPerSec;
      if (edge === "left") {
        // Left edge: clamp by source start (sourceInSec >= 0), MIN_DUR, t>=0,
        // AND no-overlap window's lower bound.
        const lowerByOverlap = window.min - initial.startSec;
        const minDragged = Math.max(
          -initial.sourceInSec,
          -initial.startSec,
          lowerByOverlap,
        );
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
        // Right edge: extend duration up to source remaining AND up to the
        // next neighbour's start.
        const sourceMaxDur = Math.max(MIN_CLIP_DURATION, sourceDur - initial.sourceInSec);
        const overlapMaxDur = window.max === Infinity
          ? Infinity
          : Math.max(MIN_CLIP_DURATION, window.max - initial.startSec + initial.durationSec);
        const maxDur = Math.min(sourceMaxDur, overlapMaxDur);
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

  // ── Double-click to edit text clip ──
  const onDoubleClick = (e: React.MouseEvent) => {
    if (clip.kind !== "text") return;
    e.stopPropagation();
    selectClip(clip.id);
    setEditingText(true);
  };

  const commitText = (next: string) => {
    const trimmed = next.slice(0, TEXT_CHAR_LIMIT);
    pushHistory();
    updateClip(clip.id, { text: trimmed });
    setEditingText(false);
  };

  // ── Right-click context menu ──
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    setCtxMenu({ x: e.clientX, y: e.clientY });
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
          : "bg-we-hover",
      ].join(" ")}
      style={{ left, width }}
      onMouseDown={onBodyMouseDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={renderClipTitle(clip, sourceMedia)}
    >
      <div
        onMouseDown={onTrimMouseDown("left")}
        className="w-1.5 shrink-0 bg-we-teal/60 hover:bg-we-teal cursor-ew-resize"
      />

      <div className="flex-1 min-w-0 relative cursor-grab active:cursor-grabbing">
        <ClipBackground clip={clip} sourceMedia={sourceMedia} width={width} />
        {editingText && clip.kind === "text" ? (
          <InlineTextEditor
            initialValue={(clip as TextClip).text}
            onCommit={commitText}
            onCancel={() => setEditingText(false)}
          />
        ) : (
          <ClipLabel clip={clip} sourceMedia={sourceMedia} />
        )}
      </div>

      <div
        onMouseDown={onTrimMouseDown("right")}
        className="w-1.5 shrink-0 bg-we-teal/60 hover:bg-we-teal cursor-ew-resize"
      />

      {ctxMenu && (
        <ContextMenu x={ctxMenu.x} y={ctxMenu.y} onClose={() => setCtxMenu(null)}>
          {clip.kind === "text" && (
            <ContextMenuItem icon={Pencil} onSelect={() => setEditingText(true)}>
              Edit text
            </ContextMenuItem>
          )}
          <ContextMenuItem
            icon={Scissors}
            onSelect={() => {
              // Move playhead inside the clip if it isn't already, then split.
              if (playheadSec <= clip.startSec || playheadSec >= clip.startSec + clip.durationSec) {
                setPlayhead(clip.startSec + clip.durationSec / 2);
              }
              splitAtPlayhead();
            }}
            shortcut="S"
          >
            Split at playhead
          </ContextMenuItem>
          <ContextMenuItem icon={MoreHorizontal} onSelect={() => selectClip(clip.id)} disabled>
            Properties (toolbar)
          </ContextMenuItem>
          <ContextMenuItem icon={Trash2} danger onSelect={() => removeClip(clip.id)} shortcut="Del">
            Delete clip
          </ContextMenuItem>
        </ContextMenu>
      )}
    </div>
  );
}

// ── Inline text editor ──

function InlineTextEditor({
  initialValue,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const remaining = TEXT_CHAR_LIMIT - value.length;

  return (
    <div className="absolute inset-0 flex items-stretch">
      <textarea
        ref={ref}
        value={value}
        maxLength={TEXT_CHAR_LIMIT}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onMouseDown={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        onBlur={() => onCommit(value)}
        onKeyDown={(e) => {
          e.stopPropagation(); // don't let parent (timeline) catch Delete / S / Space
          if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          } else if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onCommit(value);
          }
        }}
        className="flex-1 px-1.5 py-0.5 bg-amber-50/95 text-amber-900 text-xs outline-none resize-none border-2 border-amber-400 rounded-sm"
      />
      <span
        className={[
          "absolute bottom-0.5 right-1 text-[9px] font-mono tabular-nums pointer-events-none",
          remaining <= 20 ? "text-red-600" : "text-amber-700/70",
        ].join(" ")}
      >
        {remaining}
      </span>
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

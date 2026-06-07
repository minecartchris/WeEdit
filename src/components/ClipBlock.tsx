import { AudioLines, Music, Pencil, Scissors, Trash2 } from "lucide-react";
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
import { useWaveform } from "@/lib/waveform";
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
  const moveClipToTrack = useEditor((s) => s.moveClipToTrack);
  const detachAudio = useEditor((s) => s.detachAudio);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const media = useEditor((s) => s.media);
  const allClips = useEditor((s) => s.clips);
  const playheadSec = useEditor((s) => s.playheadSec);

  const [editingText, setEditingText] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; atSec: number } | null>(null);

  const sourceMedia: MediaItem | undefined =
    clip.kind !== "text"
      ? media.find((m) => m.id === (clip as MediaClip).mediaId)
      : undefined;

  const collectAnchors = useCallback((): number[] => {
    const all = Object.values(allClips);
    return [...clipEdgeAnchors(all, clip.id), playheadSec, 0];
  }, [allClips, clip.id, playheadSec]);

  // ── Body drag (move along time axis) ──
  const onBodyPointerDown = (e: React.PointerEvent) => {
    if (editingText) return;
    if (e.button !== 0) return;
    // preventDefault + pointer capture stop the browser from kicking off a
    // native HTML5 drag (which would fire `dragend` instead of `pointerup`,
    // leaking our move listener so the clip "sticks" to the cursor).
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id, e.shiftKey);
    pushHistory();

    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const initialStart = clip.startSec;
    const anchors = collectAnchors();

    const onMove = (ev: PointerEvent) => {
      const dPx = ev.clientX - startX;
      const dSec = dPx / pxPerSec;
      let nextStart = Math.max(0, initialStart + dSec);
      if (!ev.shiftKey) nextStart = snapToAnchors(nextStart, anchors, pxPerSec);

      // Which lane is the cursor over? Move to it if it accepts this clip kind.
      const overEl = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const lane = overEl?.closest<HTMLElement>("[data-track-id]");
      const laneId = lane?.getAttribute("data-track-id") ?? clip.trackId;
      const laneKind = lane?.getAttribute("data-track-kind");
      const targetTrackId =
        lane && laneKind && laneAccepts(clip.kind, laneKind) ? laneId : clip.trackId;

      const sameTrack = targetTrackId === clip.trackId;
      const liveClips = useEditor.getState().clips;
      nextStart = clampClipStart(
        clip.id,
        targetTrackId,
        clip.durationSec,
        sameTrack ? initialStart : nextStart,
        nextStart,
        liveClips,
      );
      if (sameTrack) {
        updateClip(clip.id, { startSec: nextStart });
      } else {
        moveClipToTrack(clip.id, targetTrackId, nextStart);
      }
    };
    const onUp = () => {
      try { el.releasePointerCapture?.(e.pointerId); } catch { /* capture already lost (e.g. remounted across tracks) */ }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  };

  // ── Edge trim ──
  const onTrimPointerDown = (edge: "left" | "right") => (e: React.PointerEvent) => {
    if (editingText) return;
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    selectClip(clip.id);
    pushHistory();

    const el = e.currentTarget as HTMLElement;
    el.setPointerCapture?.(e.pointerId);
    const startX = e.clientX;
    const initial = {
      startSec: clip.startSec,
      durationSec: clip.durationSec,
      sourceInSec: clip.sourceInSec,
    };
    const sourceDur =
      sourceMedia?.durationSec != null ? sourceMedia.durationSec : Infinity;
    // Speed scales how a timeline-second of trim maps onto source-seconds.
    const speed = clip.kind === "text" ? 1 : (clip as MediaClip).speed ?? 1;
    const anchors = collectAnchors();
    const overlapWin = clipNoOverlapWindow(
      clip.id,
      clip.trackId,
      initial.durationSec,
      initial.startSec,
      useEditor.getState().clips,
    );

    const onMove = (ev: PointerEvent) => {
      const dSec = (ev.clientX - startX) / pxPerSec;
      if (edge === "left") {
        // Left edge: clamp by source start (sourceInSec >= 0), MIN_DUR, t>=0,
        // AND no-overlap window's lower bound. Source moves by dragged*speed, so
        // the source-floor limit is -sourceInSec/speed timeline seconds.
        const lowerByOverlap = overlapWin.min - initial.startSec;
        const minDragged = Math.max(
          -initial.sourceInSec / speed,
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
          sourceInSec: initial.sourceInSec + dragged * speed,
          durationSec: initial.durationSec - dragged,
        });
      } else {
        // Right edge: extend duration up to source remaining AND up to the
        // next neighbour's start. Remaining source maps to timeline via /speed.
        const sourceMaxDur = Math.max(MIN_CLIP_DURATION, (sourceDur - initial.sourceInSec) / speed);
        const overlapMaxDur = overlapWin.max === Infinity
          ? Infinity
          : Math.max(MIN_CLIP_DURATION, overlapWin.max - initial.startSec + initial.durationSec);
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
      try { el.releasePointerCapture?.(e.pointerId); } catch { /* capture already lost (e.g. remounted across tracks) */ }
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
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
    // Timeline-second under the cursor, so "Split" cuts exactly where you
    // right-clicked rather than at the (possibly far-away) playhead.
    const rect = e.currentTarget.getBoundingClientRect();
    const offsetSec = (e.clientX - rect.left) / pxPerSec;
    const atSec = clip.startSec + Math.max(0, Math.min(clip.durationSec, offsetSec));
    setCtxMenu({ x: e.clientX, y: e.clientY, atSec });
  };

  const left = clip.startSec * pxPerSec;
  const width = Math.max(2, clip.durationSec * pxPerSec);

  return (
    <div
      className={[
        "absolute top-1 bottom-1 rounded-md overflow-hidden flex select-none",
        isSelected ? "ring-2 ring-we-teal z-10" : "ring-1 ring-we-border",
        clip.kind === "audio"
          ? "bg-emerald-100"
          : clip.kind === "text"
          ? "bg-amber-100"
          : "bg-we-hover",
      ].join(" ")}
      style={{ left, width }}
      draggable={false}
      onDragStart={(e) => e.preventDefault()}
      onPointerDown={onBodyPointerDown}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={onDoubleClick}
      onContextMenu={onContextMenu}
      title={renderClipTitle(clip, sourceMedia)}
    >
      <div
        onPointerDown={onTrimPointerDown("left")}
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
        onPointerDown={onTrimPointerDown("right")}
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
              // Split exactly where the user right-clicked. splitAtPlayhead
              // razors whatever sits under the playhead, so move it there first.
              setPlayhead(ctxMenu.atSec);
              splitAtPlayhead();
            }}
            shortcut="S"
          >
            Split here
          </ContextMenuItem>
          {clip.kind === "video" && (
            <ContextMenuItem icon={AudioLines} onSelect={() => detachAudio(clip.id)}>
              Detach audio
            </ContextMenuItem>
          )}
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
    return <Waveform clip={clip as MediaClip} sourceMedia={sourceMedia} width={width} />;
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

// Pseudo-random bar heights shown while the real waveform is decoding (or if
// decoding fails) so the lane doesn't look empty.
function placeholderHeights(barCount: number): number[] {
  const heights: number[] = [];
  let seed = 1337;
  for (let i = 0; i < barCount; i++) {
    seed = (seed * 9301 + 49297) % 233280;
    heights.push(0.25 + (seed / 233280) * 0.7);
  }
  return heights;
}

function WaveformBars({ heights, dim }: { heights: number[]; dim?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-end gap-px px-1 pb-1">
      {heights.map((h, i) => (
        <div
          key={i}
          className={`flex-1 rounded-sm ${dim ? "bg-emerald-500/30" : "bg-emerald-500/60"}`}
          style={{ height: `${Math.max(4, h * 100)}%` }}
        />
      ))}
    </div>
  );
}

/**
 * Real audio waveform for an audio clip: bar height tracks the source's peak
 * volume at that point in time (loud → tall, quiet → short), so the user can
 * spot speech/silence at a glance. Decoding happens off the main render path
 * (see useWaveform); until it resolves — or if the source can't be decoded —
 * a dimmed placeholder fills the space.
 */
function Waveform({
  clip,
  sourceMedia,
  width,
}: {
  clip: MediaClip;
  sourceMedia: MediaItem | undefined;
  width: number;
}) {
  const waveform = useWaveform(sourceMedia);
  const barCount = Math.max(8, Math.floor(width / 4));

  if (!waveform) {
    return <WaveformBars heights={placeholderHeights(barCount)} dim />;
  }

  const speed = clip.speed ?? 1;
  const startBucket = clip.sourceInSec * waveform.bucketsPerSec;
  const bucketSpan = clip.durationSec * speed * waveform.bucketsPerSec;

  const heights: number[] = [];
  for (let i = 0; i < barCount; i++) {
    const from = Math.max(0, Math.floor(startBucket + (i / barCount) * bucketSpan));
    const to = Math.min(
      waveform.peaks.length,
      Math.max(from + 1, Math.ceil(startBucket + ((i + 1) / barCount) * bucketSpan)),
    );
    let peak = 0;
    for (let b = from; b < to; b++) {
      if (waveform.peaks[b] > peak) peak = waveform.peaks[b];
    }
    heights.push(peak);
  }

  return <WaveformBars heights={heights} />;
}

// Whether a track lane (by kind) accepts a clip of the given kind during a
// cross-track drag. Mirrors isMediaCompatibleWithTrack but also handles text.
function laneAccepts(clipKind: Clip["kind"], trackKind: string): boolean {
  if (trackKind === "text") return clipKind === "text";
  if (trackKind === "audio") return clipKind === "audio";
  if (trackKind === "video") return clipKind === "video" || clipKind === "image";
  return false;
}

function renderClipTitle(clip: Clip, m: MediaItem | undefined): string {
  const name = clip.kind === "text" ? "Text" : m?.name ?? "Clip";
  return `${name} · ${clip.durationSec.toFixed(2)}s`;
}

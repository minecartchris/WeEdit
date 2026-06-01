import {
  ChevronDown,
  Filter,
  MessageSquare,
  MoreVertical,
  Music,
  Pencil,
  Plus,
  Redo2,
  Scissors,
  Search,
  SlidersHorizontal,
  Trash2,
  Type,
  Undo2,
  Video as VideoIcon,
  Volume2,
  VolumeX,
} from "lucide-react";
import { useMemo, useRef } from "react";
import { ClipBlock } from "@/components/ClipBlock";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { isMediaCompatibleWithTrack } from "@/lib/clips";
import { formatTimecode, useEditor } from "@/state/editor";
import type { Clip, MediaClip, TextClip, Track, TrackKind } from "@/types";

// Bottom panel: editor toolbar + time ruler + track list. Phase 1.5 wires up
// clip rendering, drag/trim, drop, split, delete, undo/redo, and per-clip A/O.
export function Timeline() {
  const tracks = useEditor((s) => s.tracks);
  const playheadSec = useEditor((s) => s.playheadSec);
  const fps = useEditor((s) => s.project.fps);
  const pxPerSec = useEditor((s) => s.pxPerSec);
  const setZoom = useEditor((s) => s.setZoom);
  const addTrack = useEditor((s) => s.addTrack);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const clearSelection = useEditor((s) => s.clearSelection);
  const clipsMap = useEditor((s) => s.clips);

  // Visible duration: at least 60s, else 1.2× the rightmost clip end.
  const totalSec = useMemo(() => {
    let max = 60;
    for (const c of Object.values(clipsMap)) {
      const end = c.startSec + c.durationSec;
      if (end > max) max = end;
    }
    return Math.max(max * 1.2, 60);
  }, [clipsMap]);

  const totalDisplay = formatTimecode(playheadSec, fps);
  const totalLength = formatTimecode(totalSec, fps);

  const rulerRef = useRef<HTMLDivElement>(null);

  const onRulerMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const lane = rulerRef.current;
    if (!lane) return;
    const rect = lane.getBoundingClientRect();
    const setFromX = (clientX: number) => {
      const x = Math.max(0, clientX - rect.left + lane.scrollLeft);
      setPlayhead(x / pxPerSec);
    };
    setFromX(e.clientX);
    const onMove = (ev: MouseEvent) => setFromX(ev.clientX);
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  return (
    <section className="shrink-0 flex flex-col bg-white border-t border-we-border">
      <TimelineToolbar
        timecode={`${totalDisplay} / ${totalLength}`}
        pxPerSec={pxPerSec}
        onZoom={setZoom}
        onAddTrack={addTrack}
      />
      <div className="flex">
        <div className="w-40 shrink-0 border-r border-we-border bg-we-trackHead" />
        <div ref={rulerRef} onMouseDown={onRulerMouseDown} className="flex-1 cursor-ew-resize">
          <Ruler totalSec={totalSec} pxPerSec={pxPerSec} playheadSec={playheadSec} />
        </div>
      </div>
      <div className="relative" onClick={(e) => {
        if (e.target === e.currentTarget) clearSelection();
      }}>
        {tracks.map((t) => (
          <TrackRow key={t.id} track={t} totalSec={totalSec} pxPerSec={pxPerSec} />
        ))}
        <PlayheadOverlay playheadSec={playheadSec} pxPerSec={pxPerSec} />
        <TimelineDropHint visible={tracks.every((t) => t.clipIds.length === 0)} />
      </div>
    </section>
  );
}

function TimelineToolbar({
  timecode,
  pxPerSec,
  onZoom,
  onAddTrack,
}: {
  timecode: string;
  pxPerSec: number;
  onZoom: (n: number) => void;
  onAddTrack: (kind: TrackKind) => void;
}) {
  const undo = useEditor((s) => s.undo);
  const redo = useEditor((s) => s.redo);
  const past = useEditor((s) => s.past);
  const future = useEditor((s) => s.future);
  const splitAtPlayhead = useEditor((s) => s.splitAtPlayhead);
  const deleteSelected = useEditor((s) => s.deleteSelected);
  const selectedCount = useEditor((s) => s.selectedClipIds.length);

  return (
    <div className="h-11 shrink-0 flex items-center gap-1 px-3 border-b border-we-border">
      <Menu
        trigger={({ onClick }) => (
          <button
            onClick={onClick}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded text-sm text-we-ink hover:bg-slate-100"
          >
            <Plus className="w-4 h-4 text-we-teal" />
            Track
            <ChevronDown className="w-3.5 h-3.5" />
          </button>
        )}
      >
        <MenuLabel>Add track</MenuLabel>
        <MenuItem icon={VideoIcon} onSelect={() => onAddTrack("video")}>Video track</MenuItem>
        <MenuItem icon={Music}     onSelect={() => onAddTrack("audio")}>Audio track</MenuItem>
        <MenuItem icon={Type}      onSelect={() => onAddTrack("text")}>Text track</MenuItem>
      </Menu>

      <Sep />

      <ToolbarButton
        icon={Undo2}
        label="Undo"
        shortcut="Ctrl+Z"
        disabled={past.length === 0}
        onClick={undo}
      />
      <ToolbarButton
        icon={Redo2}
        label="Redo"
        shortcut="Ctrl+Y"
        disabled={future.length === 0}
        onClick={redo}
      />

      <Sep />

      <ToolbarButton
        icon={Scissors}
        accent
        label="Split"
        shortcut="S"
        onClick={splitAtPlayhead}
      />
      <ToolbarButton
        icon={MessageSquare}
        accent
        label="Comment"
        disabled
      />

      <AudioOpacityMenu />
      <TextPropertiesMenu />

      <Sep />

      <ToolbarButton icon={Pencil} accent label="Edit" disabled />
      <ToolbarButton icon={Filter} accent label="Filters" disabled />
      <ToolbarButton
        icon={Trash2}
        label="Delete"
        shortcut="Del"
        disabled={selectedCount === 0}
        onClick={deleteSelected}
      />

      <div className="flex-1" />

      <span className="font-mono text-sm text-we-ink tabular-nums">{timecode}</span>

      <div className="flex items-center gap-2 ml-3">
        <Search className="w-4 h-4 text-we-muted" />
        <input
          type="range"
          min={0.5}
          max={50}
          step={0.5}
          value={pxPerSec}
          onChange={(e) => onZoom(parseFloat(e.target.value))}
          className="accent-we-teal w-32"
          aria-label="Timeline zoom"
        />
        <Search className="w-4 h-4 text-we-muted" />
      </div>
    </div>
  );
}

function ToolbarButton({
  icon: Icon,
  label,
  shortcut,
  onClick,
  disabled,
  accent,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  shortcut?: string;
  onClick?: () => void;
  disabled?: boolean;
  accent?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={shortcut ? `${label} (${shortcut})` : label}
      className={[
        "we-btn-ghost",
        disabled ? "opacity-40 cursor-not-allowed" : "",
      ].join(" ")}
    >
      <Icon className={["w-4 h-4", accent && !disabled ? "text-we-teal" : "text-we-muted"].join(" ")} />
      {label}
    </button>
  );
}

function AudioOpacityMenu() {
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const setMediaAudioTrackMuted = useEditor((s) => s.setMediaAudioTrackMuted);
  const selectedCount = useEditor((s) => s.selectedClipIds.length);
  // Read the single selected media clip directly from state so the selector
  // returns a stable reference (or null) — required by useSyncExternalStore.
  const target = useEditor((s): MediaClip | null => {
    if (s.selectedClipIds.length !== 1) return null;
    const c = s.clips[s.selectedClipIds[0]];
    if (!c || c.kind === "text") return null;
    return c as MediaClip;
  });
  const targetMedia = useEditor((s) => {
    if (!target) return null;
    return s.media.find((m) => m.id === target.mediaId) ?? null;
  });

  return (
    <Menu
      trigger={({ onClick }) => (
        <button onClick={onClick} className="we-btn-ghost">
          <SlidersHorizontal
            className={[
              "w-4 h-4",
              target ? "text-we-teal" : "text-we-muted",
            ].join(" ")}
          />
          Audio &amp; Opacity
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    >
      {!target ? (
        <MenuItem disabled>
          {selectedCount === 0
            ? "Select a clip first"
            : selectedCount > 1
            ? "Select a single clip"
            : "Not available for text"}
        </MenuItem>
      ) : (
        <div className="px-3 py-2 flex flex-col gap-3 min-w-[280px]">
          <MenuLabel>Selected clip</MenuLabel>
          {target.kind !== "audio" && (
            <SliderField
              label="Opacity"
              value={target.opacity}
              onMouseDown={pushHistory}
              onChange={(v) => updateClip(target.id, { opacity: v })}
            />
          )}
          {target.kind !== "image" && (
            <SliderField
              label="Volume"
              value={target.volume}
              onMouseDown={pushHistory}
              onChange={(v) => updateClip(target.id, { volume: v })}
            />
          )}
          {targetMedia?.audioTracks && targetMedia.audioTracks.length > 1 && (
            <>
              <MenuLabel>Audio tracks ({targetMedia.audioTracks.length})</MenuLabel>
              <div className="flex flex-col gap-1.5">
                {targetMedia.audioTracks.map((t) => (
                  <TrackMuteRow
                    key={t.index}
                    label={trackDisplayName(t)}
                    muted={t.muted}
                    onToggle={() =>
                      setMediaAudioTrackMuted(targetMedia.id, t.index, !t.muted)
                    }
                  />
                ))}
              </div>
              <div className="text-[10px] text-we-muted leading-4">
                Per-track mute applies to all clips using this media.
              </div>
            </>
          )}
        </div>
      )}
    </Menu>
  );
}

function TrackMuteRow({
  label,
  muted,
  onToggle,
}: {
  label: string;
  muted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-slate-100 text-left"
    >
      {muted ? (
        <VolumeX className="w-4 h-4 text-we-muted" />
      ) : (
        <Volume2 className="w-4 h-4 text-we-teal" />
      )}
      <span className={["flex-1 truncate", muted ? "text-we-muted line-through" : "text-we-ink"].join(" ")}>
        {label}
      </span>
    </button>
  );
}

function trackDisplayName(t: import("@/types").AudioTrackInfo): string {
  const parts: string[] = [];
  parts.push(`Track ${t.index + 1}`);
  if (t.title) parts.push(t.title);
  if (t.language) parts.push(`(${t.language})`);
  if (t.codec || t.channels) {
    const tech = [t.codec, t.channels ? `${t.channels}ch` : null].filter(Boolean).join(" · ");
    if (tech) parts.push(`· ${tech}`);
  }
  return parts.join(" ");
}

function SliderField({
  label,
  value,
  onChange,
  onMouseDown,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onMouseDown?: () => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-we-ink">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="text-we-muted tabular-nums">{Math.round(value * 100)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onMouseDown={onMouseDown}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="accent-we-teal"
      />
    </label>
  );
}

// Toolbar dropdown for the selected text clip. Mirrors AudioOpacityMenu's
// "stable selector returning a single clip or null" pattern.
function TextPropertiesMenu() {
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const target = useEditor((s): TextClip | null => {
    if (s.selectedClipIds.length !== 1) return null;
    const c = s.clips[s.selectedClipIds[0]];
    if (!c || c.kind !== "text") return null;
    return c as TextClip;
  });

  return (
    <Menu
      trigger={({ onClick }) => (
        <button
          onClick={onClick}
          className="we-btn-ghost"
          title={target ? "Edit text properties" : "Select a text clip"}
        >
          <Type
            className={["w-4 h-4", target ? "text-we-teal" : "text-we-muted"].join(" ")}
          />
          Text
          <ChevronDown className="w-3.5 h-3.5" />
        </button>
      )}
    >
      {!target ? (
        <MenuItem disabled>Select a text clip to edit</MenuItem>
      ) : (
        <div className="px-3 py-2 flex flex-col gap-3 min-w-[300px]">
          <MenuLabel>Text properties</MenuLabel>

          <label className="flex flex-col gap-1 text-xs text-we-ink">
            <span>Content</span>
            <textarea
              value={target.text}
              onFocus={pushHistory}
              onChange={(e) => updateClip(target.id, { text: e.target.value })}
              rows={2}
              className="we-input resize-none"
            />
          </label>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-xs text-we-ink">
              <span>Font</span>
              <select
                value={target.fontFamily}
                onMouseDown={pushHistory}
                onChange={(e) => updateClip(target.id, { fontFamily: e.target.value })}
                className="we-input"
              >
                {FONT_OPTIONS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-we-ink">
              <span>Size (px)</span>
              <input
                type="number"
                min={8}
                max={400}
                value={target.fontSizePx}
                onFocus={pushHistory}
                onChange={(e) => updateClip(target.id, { fontSizePx: parseInt(e.target.value, 10) || 0 })}
                className="we-input"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-xs text-we-ink">
            <span>Color</span>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={target.color}
                onMouseDown={pushHistory}
                onChange={(e) => updateClip(target.id, { color: e.target.value })}
                className="h-8 w-12 rounded border border-we-border cursor-pointer"
              />
              <input
                type="text"
                value={target.color}
                onFocus={pushHistory}
                onChange={(e) => updateClip(target.id, { color: e.target.value })}
                className="we-input flex-1 font-mono tabular-nums"
              />
            </div>
          </label>

          <div className="grid grid-cols-2 gap-2">
            <PercentField
              label="X position"
              value={target.xPct}
              onMouseDown={pushHistory}
              onChange={(v) => updateClip(target.id, { xPct: v })}
            />
            <PercentField
              label="Y position"
              value={target.yPct}
              onMouseDown={pushHistory}
              onChange={(v) => updateClip(target.id, { yPct: v })}
            />
          </div>
        </div>
      )}
    </Menu>
  );
}

const FONT_OPTIONS = [
  { label: "Inter / system", value: "Inter, system-ui, sans-serif" },
  { label: "Arial / Helvetica", value: "Arial, Helvetica, sans-serif" },
  { label: "Times serif", value: "'Times New Roman', Times, serif" },
  { label: "Georgia serif", value: "Georgia, serif" },
  { label: "Courier mono", value: "'Courier New', Courier, monospace" },
  { label: "Impact (display)", value: "Impact, Haettenschweiler, sans-serif" },
  { label: "Comic (casual)", value: "'Comic Sans MS', cursive, sans-serif" },
  { label: "Trebuchet", value: "'Trebuchet MS', sans-serif" },
];

function PercentField({
  label,
  value,
  onChange,
  onMouseDown,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  onMouseDown?: () => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-we-ink">
      <div className="flex items-center justify-between">
        <span>{label}</span>
        <span className="text-we-muted tabular-nums">{Math.round(value)}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={100}
        step={1}
        value={value}
        onMouseDown={onMouseDown}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="accent-we-teal"
      />
    </label>
  );
}

function Sep() {
  return <div className="w-px h-5 bg-we-border mx-1" />;
}

function Ruler({
  totalSec,
  pxPerSec,
  playheadSec,
}: {
  totalSec: number;
  pxPerSec: number;
  playheadSec: number;
}) {
  const niceIntervals = [1, 2, 5, 10, 30, 60, 300, 600, 1800, 3600];
  const targetPxPerTick = 120;
  const desiredSec = targetPxPerTick / pxPerSec;
  const major = niceIntervals.find((s) => s >= desiredSec) ?? 3600;
  const ticks: number[] = [];
  for (let s = 0; s <= totalSec; s += major) ticks.push(s);

  return (
    <div className="relative h-7 overflow-hidden bg-white border-b border-we-border">
      <div className="relative h-full" style={{ width: totalSec * pxPerSec }}>
        {ticks.map((s) => (
          <div
            key={s}
            className="absolute top-0 h-full text-[11px] text-we-muted border-l border-we-border pl-1 pt-0.5 tabular-nums"
            style={{ left: s * pxPerSec }}
          >
            {labelForSec(s)}
          </div>
        ))}
        <div
          className="absolute top-0 bottom-0 w-px bg-we-teal"
          style={{ left: playheadSec * pxPerSec }}
        />
      </div>
    </div>
  );
}

function labelForSec(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function TrackRow({
  track,
  totalSec,
  pxPerSec,
}: {
  track: Track;
  totalSec: number;
  pxPerSec: number;
}) {
  const dragSession = useEditor((s) => s.dragSession);
  const hoverTrackId = useEditor((s) => s.hoverTrackId);
  const clipsMap = useEditor((s) => s.clips);
  const clearSelection = useEditor((s) => s.clearSelection);

  const clips: Clip[] = useMemo(
    () =>
      track.clipIds
        .map((id) => clipsMap[id])
        .filter((c): c is Clip => Boolean(c)),
    [track.clipIds, clipsMap],
  );

  // Visual compatibility comes from the active drag session; "hovering" is set
  // by the custom drag controller via setHoverTrackId. Native HTML5 drop is no
  // longer used — see src/lib/customDrag.ts.
  const visualCompatibility: "compatible" | "incompatible" | "idle" = dragSession
    ? isMediaCompatibleWithTrack(dragSession.kind, track)
      ? "compatible"
      : "incompatible"
    : "idle";
  const isHovered = hoverTrackId === track.id;

  return (
    <div className="flex border-b border-we-border min-h-[64px]">
      <TrackHeader track={track} />
      <div
        className={[
          "relative flex-1 transition-colors",
          visualCompatibility === "compatible" && isHovered ? "bg-we-teal/15 ring-1 ring-inset ring-we-teal/60" : "bg-slate-50/40",
          visualCompatibility === "incompatible" && isHovered ? "bg-red-100/40" : "",
        ].join(" ")}
        style={{ minWidth: totalSec * pxPerSec }}
        data-track-id={track.id}
        data-track-kind={track.kind}
        onClick={(e) => {
          if (e.target === e.currentTarget) clearSelection();
        }}
      >
        {clips.map((c) => (
          <ClipBlock key={c.id} clip={c} pxPerSec={pxPerSec} />
        ))}
      </div>
    </div>
  );
}

function TrackHeader({ track }: { track: Track }) {
  const setVolume = useEditor((s) => s.setTrackVolume);
  const setMuted = useEditor((s) => s.setTrackMuted);
  const renameTrack = useEditor((s) => s.renameTrack);
  const removeTrack = useEditor((s) => s.removeTrack);

  const onRename = () => {
    const next = window.prompt(`Rename ${track.name}`, track.name);
    if (next != null) {
      const trimmed = next.trim();
      if (trimmed) renameTrack(track.id, trimmed);
    }
  };

  const onDelete = () => {
    if (window.confirm(`Delete ${track.name}? This will also remove its clips.`)) {
      removeTrack(track.id);
    }
  };

  const audible = track.kind !== "text";
  return (
    <div className="w-40 shrink-0 px-3 py-2 border-r border-we-border bg-we-trackHead flex flex-col justify-between">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-we-ink truncate" title={track.name}>{track.name}</span>
        <Menu
          align="right"
          trigger={({ onClick }) => (
            <button onClick={onClick} className="we-btn-ghost p-1" aria-label={`${track.name} options`}>
              <MoreVertical className="w-4 h-4" />
            </button>
          )}
        >
          <MenuItem onSelect={onRename}>Rename…</MenuItem>
          <MenuItem onSelect={() => setMuted(track.id, !track.muted)}>
            {track.muted ? "Unmute" : "Mute"}
          </MenuItem>
          <MenuSeparator />
          <MenuItem danger icon={Trash2} onSelect={onDelete}>Delete track</MenuItem>
        </Menu>
      </div>
      <div className={["flex items-center gap-2", audible ? "" : "opacity-60"].join(" ")}>
        <button
          onClick={() => audible && setMuted(track.id, !track.muted)}
          disabled={!audible}
          className="we-btn-ghost p-0.5"
          title={track.muted ? "Unmute" : "Mute"}
        >
          {track.muted ? (
            <VolumeX className="w-4 h-4 text-we-muted" />
          ) : (
            <Volume2 className="w-4 h-4 text-we-muted" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={track.volume}
          disabled={!audible}
          onChange={(e) => setVolume(track.id, parseFloat(e.target.value))}
          className="accent-we-teal flex-1"
          aria-label={`${track.name} volume`}
        />
      </div>
    </div>
  );
}

function PlayheadOverlay({
  playheadSec,
  pxPerSec,
}: {
  playheadSec: number;
  pxPerSec: number;
}) {
  return (
    <div
      className="absolute top-0 bottom-0 w-px bg-we-teal pointer-events-none"
      style={{ left: 160 + playheadSec * pxPerSec }}
    />
  );
}

function TimelineDropHint({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="absolute inset-0 grid place-items-center pointer-events-none">
      <div className="flex flex-col items-center gap-2 text-we-muted">
        <DropAffordanceArt />
        <p className="text-sm">Drag and drop media from the library above</p>
      </div>
    </div>
  );
}

function DropAffordanceArt() {
  return (
    <svg width="170" height="80" viewBox="0 0 170 80" fill="none" aria-hidden>
      <rect x="6" y="6" width="68" height="52" rx="6" fill="#e2e8f0" />
      <path d="M14 50l16-18 10 12 8-8 18 14H14z" fill="#94a3b8" />
      <circle cx="32" cy="22" r="5" fill="#cbd5e1" />
      <path
        d="M82 30c10 14 22 18 36 8"
        stroke="#94a3b8"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray="3 3"
      />
      <path d="M114 32l8 8-9 5" stroke="#94a3b8" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="100" y="34" width="62" height="42" rx="6" stroke="#cbd5e1" strokeDasharray="4 4" />
      <path d="M124 56l8-9 6 7 4-4 8 8h-26z" fill="#cbd5e1" />
    </svg>
  );
}

import { AudioLines, MousePointerSquareDashed, SlidersHorizontal, Volume2, VolumeX } from "lucide-react";
import { NumberField } from "@/components/ui/NumberField";
import { MAX_SCALE, MIN_SCALE, TEXT_CHAR_LIMIT, pctToPx, pxToPct } from "@/lib/clips";
import { useEditor } from "@/state/editor";
import { usePrefs } from "@/state/prefs";
import type { AudioTrackInfo, Clip, MediaClip, TextClip } from "@/types";

// Right-hand properties panel for the single selected clip. This is the home
// for all clip editing — text content/style, opacity/volume, per-source audio
// track mute, and on-stage transform (position + scale). It replaces the old
// Timeline-toolbar dropdowns.

export function Inspector() {
  // Stable single-clip selector (returns one clip or null) — required by
  // useSyncExternalStore; never return a freshly-built array from a selector.
  const clip = useEditor((s): Clip | null => {
    if (s.selectedClipIds.length !== 1) return null;
    return s.clips[s.selectedClipIds[0]] ?? null;
  });
  const selectedCount = useEditor((s) => s.selectedClipIds.length);

  return (
    <aside className="h-full w-full flex flex-col bg-we-panel border-l border-we-border min-w-0">
      <div className="h-12 shrink-0 flex items-center gap-2 px-4 border-b border-we-border">
        <SlidersHorizontal className="w-4 h-4 text-we-teal" />
        <span className="text-sm font-medium text-we-ink">Properties</span>
      </div>
      <div className="flex-1 overflow-auto">
        {clip ? <ClipInspector clip={clip} /> : <Empty count={selectedCount} />}
      </div>
    </aside>
  );
}

function Empty({ count }: { count: number }) {
  return (
    <div className="h-full grid place-items-center text-center px-6 text-we-muted">
      <div className="flex flex-col items-center gap-2">
        <MousePointerSquareDashed className="w-8 h-8" />
        <p className="text-sm">
          {count > 1 ? "Select a single clip to edit its properties." : "Select a clip to edit its properties."}
        </p>
      </div>
    </div>
  );
}

function ClipInspector({ clip }: { clip: Clip }) {
  return (
    <div className="p-4 flex flex-col gap-5">
      <KindBadge clip={clip} />
      {clip.kind === "text" ? <TextProps clip={clip} /> : <MediaProps clip={clip} />}
      {clip.kind !== "audio" && <TransformProps clip={clip} />}
    </div>
  );
}

function KindBadge({ clip }: { clip: Clip }) {
  const label =
    clip.kind === "text" ? "Text" : clip.kind === "image" ? "Image" : clip.kind === "audio" ? "Audio" : "Video";
  return (
    <div className="text-[11px] uppercase tracking-wide text-we-muted">{label} clip</div>
  );
}

// ── Sections ─────────────────────────────────────────────────────────────────

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-semibold text-we-ink">{children}</div>;
}

function TransformProps({ clip }: { clip: MediaClip | TextClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const unit = usePrefs((s) => s.positionUnit);
  const frameW = useEditor((s) => s.project.width);
  const frameH = useEditor((s) => s.project.height);
  const pixels = unit === "pixels";

  return (
    <section className="flex flex-col gap-3 border-t border-we-border pt-4">
      <SectionTitle>Transform</SectionTitle>
      <NumberField
        label={`X position${pixels ? " (px)" : ""}`}
        value={pixels ? pctToPx(clip.xPct, frameW) : clip.xPct}
        min={pixels ? Math.round(-0.5 * frameW) : -50}
        max={pixels ? Math.round(1.5 * frameW) : 150}
        step={pixels ? 1 : 0.1}
        decimals={pixels ? 0 : 1}
        suffix={pixels ? "px" : "%"}
        onCommitStart={pushHistory}
        onChange={(v) => updateClip(clip.id, { xPct: pixels ? pxToPct(v, frameW) : v })}
      />
      <NumberField
        label={`Y position${pixels ? " (px)" : ""}`}
        value={pixels ? pctToPx(clip.yPct, frameH) : clip.yPct}
        min={pixels ? Math.round(-0.5 * frameH) : -50}
        max={pixels ? Math.round(1.5 * frameH) : 150}
        step={pixels ? 1 : 0.1}
        decimals={pixels ? 0 : 1}
        suffix={pixels ? "px" : "%"}
        onCommitStart={pushHistory}
        onChange={(v) => updateClip(clip.id, { yPct: pixels ? pxToPct(v, frameH) : v })}
      />
      <NumberField
        label="Scale / zoom"
        value={Math.round(clip.scale * 100)}
        min={Math.round(MIN_SCALE * 100)}
        max={Math.round(MAX_SCALE * 100)}
        step={1}
        suffix="%"
        onCommitStart={pushHistory}
        onChange={(v) => updateClip(clip.id, { scale: v / 100 })}
      />
    </section>
  );
}

function MediaProps({ clip }: { clip: MediaClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const setMediaAudioTrackMuted = useEditor((s) => s.setMediaAudioTrackMuted);
  const detachAudio = useEditor((s) => s.detachAudio);
  const media = useEditor((s) => s.media.find((m) => m.id === clip.mediaId) ?? null);

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Clip</SectionTitle>
      {clip.kind !== "audio" && (
        <NumberField
          label="Opacity"
          value={Math.round(clip.opacity * 100)}
          min={0}
          max={100}
          suffix="%"
          onCommitStart={pushHistory}
          onChange={(v) => updateClip(clip.id, { opacity: v / 100 })}
        />
      )}
      {clip.kind !== "image" && (
        <NumberField
          label="Volume"
          value={Math.round(clip.volume * 100)}
          min={0}
          max={100}
          suffix="%"
          onCommitStart={pushHistory}
          onChange={(v) => updateClip(clip.id, { volume: v / 100 })}
        />
      )}
      {media?.audioTracks && media.audioTracks.length > 1 && (
        <div className="flex flex-col gap-1.5">
          <SectionTitle>Audio tracks ({media.audioTracks.length})</SectionTitle>
          {media.audioTracks.map((t) => (
            <TrackMuteRow
              key={t.index}
              label={trackDisplayName(t)}
              muted={t.muted}
              onToggle={() => setMediaAudioTrackMuted(media.id, t.index, !t.muted)}
            />
          ))}
          <div className="text-[10px] text-we-muted leading-4">
            Per-track mute applies to all clips using this media.
          </div>
        </div>
      )}
      {clip.kind === "video" && (
        <button
          onClick={() => detachAudio(clip.id)}
          className="we-btn justify-center border border-we-border mt-1"
          title="Split this clip's audio onto its own audio track"
        >
          <AudioLines className="w-4 h-4 text-we-teal" />
          Detach audio
        </button>
      )}
    </section>
  );
}

function TextProps({ clip }: { clip: TextClip }) {
  const updateClip = useEditor((s) => s.updateClip);
  const pushHistory = useEditor((s) => s.pushHistory);
  const remaining = TEXT_CHAR_LIMIT - clip.text.length;

  return (
    <section className="flex flex-col gap-3">
      <SectionTitle>Text</SectionTitle>
      <label className="flex flex-col gap-1 text-xs text-we-ink">
        <div className="flex items-center justify-between">
          <span className="text-we-muted">Content</span>
          <span className={["text-[10px] tabular-nums", remaining <= 20 ? "text-red-500" : "text-we-muted"].join(" ")}>
            {clip.text.length} / {TEXT_CHAR_LIMIT}
          </span>
        </div>
        <textarea
          value={clip.text}
          maxLength={TEXT_CHAR_LIMIT}
          onFocus={pushHistory}
          onChange={(e) => updateClip(clip.id, { text: e.target.value.slice(0, TEXT_CHAR_LIMIT) })}
          rows={3}
          className="we-input resize-none"
        />
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="flex flex-col gap-1 text-xs text-we-ink">
          <span className="text-we-muted">Font</span>
          <select
            value={clip.fontFamily}
            onMouseDown={pushHistory}
            onChange={(e) => updateClip(clip.id, { fontFamily: e.target.value })}
            className="we-input"
          >
            {FONT_OPTIONS.map((f) => (
              <option key={f.value} value={f.value}>{f.label}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-we-ink">
          <span className="text-we-muted">Size (px)</span>
          <input
            type="number"
            min={8}
            max={400}
            value={clip.fontSizePx}
            onFocus={pushHistory}
            onChange={(e) => updateClip(clip.id, { fontSizePx: parseInt(e.target.value, 10) || 0 })}
            className="we-input"
          />
        </label>
      </div>

      <label className="flex flex-col gap-1 text-xs text-we-ink">
        <span className="text-we-muted">Color</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={clip.color}
            onMouseDown={pushHistory}
            onChange={(e) => updateClip(clip.id, { color: e.target.value })}
            className="h-8 w-12 rounded border border-we-border cursor-pointer bg-we-panel"
          />
          <input
            type="text"
            value={clip.color}
            onFocus={pushHistory}
            onChange={(e) => updateClip(clip.id, { color: e.target.value })}
            className="we-input flex-1 font-mono tabular-nums"
          />
        </div>
      </label>
    </section>
  );
}

function TrackMuteRow({ label, muted, onToggle }: { label: string; muted: boolean; onToggle: () => void }) {
  return (
    <button
      onClick={onToggle}
      className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-we-hover text-left"
    >
      {muted ? <VolumeX className="w-4 h-4 text-we-muted" /> : <Volume2 className="w-4 h-4 text-we-teal" />}
      <span className={["flex-1 truncate", muted ? "text-we-muted line-through" : "text-we-ink"].join(" ")}>
        {label}
      </span>
    </button>
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

function trackDisplayName(t: AudioTrackInfo): string {
  const parts: string[] = [`Track ${t.index + 1}`];
  if (t.title) parts.push(t.title);
  if (t.language) parts.push(`(${t.language})`);
  if (t.codec || t.channels) {
    const tech = [t.codec, t.channels ? `${t.channels}ch` : null].filter(Boolean).join(" · ");
    if (tech) parts.push(`· ${tech}`);
  }
  return parts.join(" ");
}

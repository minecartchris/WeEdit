import { Plus, Type } from "lucide-react";
import { useEditor } from "@/state/editor";
import type { TextClip, TrackKind } from "@/types";

// Click a preset to add a TextClip at the current playhead on the first text
// track. If no text track exists, we add one first. Phase 2 of text: drag
// preset onto a specific track with positional drop.

interface TextPreset {
  id: string;
  label: string;
  text: string;
  fontFamily: string;
  fontSizePx: number;
  color: string;
  xPct: number;
  yPct: number;
  durationSec: number;
}

const PRESETS: TextPreset[] = [
  {
    id: "title-large",
    label: "Title — large white",
    text: "Title",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSizePx: 96,
    color: "#ffffff",
    xPct: 50,
    yPct: 30,
    durationSec: 4,
  },
  {
    id: "title-yellow",
    label: "Title — punchy yellow",
    text: "WHEN IT ALL GOES WRONG",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSizePx: 88,
    color: "#facc15",
    xPct: 50,
    yPct: 30,
    durationSec: 4,
  },
  {
    id: "subtitle",
    label: "Subtitle — center white",
    text: "Subtitle text",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSizePx: 48,
    color: "#ffffff",
    xPct: 50,
    yPct: 88,
    durationSec: 4,
  },
  {
    id: "caption",
    label: "Caption — small bottom",
    text: "Caption",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSizePx: 28,
    color: "#ffffff",
    xPct: 50,
    yPct: 92,
    durationSec: 4,
  },
  {
    id: "lower-third",
    label: "Lower third — left aligned",
    text: "Name here",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSizePx: 42,
    color: "#ffffff",
    xPct: 22,
    yPct: 80,
    durationSec: 5,
  },
  {
    id: "callout",
    label: "Callout — red shout",
    text: "BIG MOMENT",
    fontFamily: "Inter, system-ui, sans-serif",
    fontSizePx: 110,
    color: "#ef4444",
    xPct: 50,
    yPct: 50,
    durationSec: 2,
  },
];

export function TextPanel() {
  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-5 py-3 border-b border-we-border bg-we-panel">
        <Type className="w-5 h-5 text-we-teal" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-we-ink">Text</div>
          <div className="text-[11px] text-we-muted">
            Click a preset to add at the playhead, then edit in the timeline toolbar.
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {PRESETS.map((p) => (
            <PresetCard key={p.id} preset={p} />
          ))}
          <BlankCard />
        </div>
      </div>
    </div>
  );
}

function addPresetClip(preset: TextPreset | null) {
  const state = useEditor.getState();
  // Find or create a text track.
  let track = state.tracks.find((t) => t.kind === "text");
  if (!track) {
    const id = state.addTrack("text" as TrackKind);
    track = useEditor.getState().tracks.find((t) => t.id === id);
  }
  if (!track) return;

  const clip: TextClip = {
    id: crypto.randomUUID(),
    trackId: track.id,
    startSec: state.playheadSec,
    durationSec: preset?.durationSec ?? 4,
    sourceInSec: 0,
    kind: "text",
    text: preset?.text ?? "Your text",
    fontFamily: preset?.fontFamily ?? "Inter, system-ui, sans-serif",
    fontSizePx: preset?.fontSizePx ?? 48,
    color: preset?.color ?? "#ffffff",
    xPct: preset?.xPct ?? 50,
    yPct: preset?.yPct ?? 50,
    scale: 1,
  };
  state.addClip(clip);
}

function PresetCard({ preset }: { preset: TextPreset }) {
  return (
    <button
      onClick={() => addPresetClip(preset)}
      className="text-left rounded-lg border border-we-border overflow-hidden bg-we-panel hover:shadow-md transition-shadow"
      title={`${preset.label} — click to add at playhead`}
    >
      <div className="aspect-video bg-slate-900 relative grid place-items-center px-3">
        <span
          style={{
            fontFamily: preset.fontFamily,
            fontSize: `${Math.min(preset.fontSizePx, 64) * 0.45}px`,
            color: preset.color,
            textShadow: "0 2px 12px rgba(0,0,0,0.55)",
            lineHeight: 1,
            textAlign: "center",
          }}
        >
          {preset.text}
        </span>
      </div>
      <div className="px-3 py-2 text-xs text-we-ink truncate">{preset.label}</div>
    </button>
  );
}

function BlankCard() {
  return (
    <button
      onClick={() => addPresetClip(null)}
      className="text-left rounded-lg border border-dashed border-we-border overflow-hidden bg-we-rail hover:bg-we-panel hover:shadow-md transition-all"
      title="Add a blank text clip at the playhead"
    >
      <div className="aspect-video grid place-items-center text-we-muted">
        <div className="flex flex-col items-center gap-1">
          <Plus className="w-6 h-6" />
          <span className="text-xs">Blank text</span>
        </div>
      </div>
      <div className="px-3 py-2 text-xs text-we-ink">Empty starting point</div>
    </button>
  );
}

import { ChevronDown, ChevronRight, Diamond } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useEditor } from "@/state/editor";
import { usePrefs } from "@/state/prefs";
import type { Clip, Keyframe, MediaClip } from "@/types";

type Property = "volume" | "xPct" | "yPct" | "scale" | "rotation" | "tilt";

const PROPERTIES: { key: Property; label: string; unit: string; format: (v: number) => string }[] = [
  { key: "volume",   label: "Volume",   unit: "%", format: (v) => `${Math.round(v * 100)}%` },
  { key: "xPct",     label: "X",        unit: "%", format: (v) => `${Math.round(v)}%` },
  { key: "yPct",     label: "Y",        unit: "%", format: (v) => `${Math.round(v)}%` },
  { key: "scale",    label: "Zoom",     unit: "%", format: (v) => `${Math.round(v * 100)}%` },
  { key: "rotation", label: "Rotation", unit: "°", format: (v) => `${Math.round(v)}°` },
  { key: "tilt",     label: "Tilt",     unit: "°", format: (v) => `${Math.round(v)}°` },
];

const PADDING_LEFT = 32;
const PADDING_RIGHT = 16;
const GRAPH_HEIGHT = 100;
const HEADER_HEIGHT = 32;

export function KeyframeEditor() {
  const clip = useEditor((s): Clip | null => {
    if (s.selectedClipIds.length !== 1) return null;
    return s.clips[s.selectedClipIds[0]] ?? null;
  });
  const open = usePrefs((s) => s.keyframeEditorOpen);
  const setOpen = usePrefs((s) => s.setKeyframeEditorOpen);

  if (!clip) return null;
  if (clip.kind === "text") return null;

  return (
    <div className="border-t border-we-border bg-we-panel shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="w-full h-8 flex items-center gap-1.5 px-3 text-xs font-medium text-we-ink hover:bg-we-hover transition-colors"
      >
        {open ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        <Diamond className="w-3 h-3 text-we-teal" />
        Keyframes
      </button>
      {open && <KeyframeGraph clip={clip as MediaClip} />}
    </div>
  );
}

function KeyframeGraph({ clip }: { clip: MediaClip }) {
  const [prop, setProp] = useState<Property>("volume");
  const playheadSec = useEditor((s) => s.playheadSec);
  const setPlayhead = useEditor((s) => s.setPlayhead);
  const containerRef = useRef<HTMLDivElement>(null);

  const localPlayhead = playheadSec - clip.startSec;
  const dur = clip.durationSec;

  const hasTransformKfs = (clip.keyframes ?? []).length > 0;
  const hasVolumeKfs = (clip.volumeKeyframes ?? []).length > 0;

  const availableProps = useMemo(() => {
    return PROPERTIES.filter((p) => {
      if (p.key === "volume") return clip.kind !== "image";
      return clip.kind !== "audio";
    });
  }, [clip.kind]);

  const { points, minVal, maxVal } = useMemo(() => {
    if (prop === "volume") {
      const kfs = clip.volumeKeyframes ?? [];
      if (kfs.length === 0) {
        return { points: [{ t: 0, v: clip.volume }, { t: dur, v: clip.volume }], minVal: 0, maxVal: Math.max(clip.volume * 1.2, 1) };
      }
      const pts = kfs.map((k) => ({ t: k.tSec, v: k.volume }));
      const vals = pts.map((p) => p.v);
      const lo = Math.min(...vals, 0);
      const hi = Math.max(...vals, 1);
      const pad = (hi - lo) * 0.15 || 0.2;
      return { points: pts, minVal: lo, maxVal: hi + pad };
    }
    const kfs = clip.keyframes ?? [];
    if (kfs.length === 0) {
      const staticVal = (clip as unknown as Record<string, number>)[prop];
      return { points: [{ t: 0, v: staticVal }, { t: dur, v: staticVal }], minVal: staticVal - 10, maxVal: staticVal + 10 };
    }
    const pts = kfs.map((k) => ({ t: k.tSec, v: k[prop as keyof Keyframe] as number }));
    const vals = pts.map((p) => p.v);
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const pad = (hi - lo) * 0.15 || 10;
    return { points: pts, minVal: lo - pad, maxVal: hi + pad };
  }, [clip, prop, dur]);

  const tToX = useCallback(
    (t: number, width: number) => {
      const graphW = width - PADDING_LEFT - PADDING_RIGHT;
      return PADDING_LEFT + (t / dur) * graphW;
    },
    [dur],
  );

  const vToY = useCallback(
    (v: number) => {
      const range = maxVal - minVal || 1;
      return GRAPH_HEIGHT - ((v - minVal) / range) * GRAPH_HEIGHT;
    },
    [minVal, maxVal],
  );

  const onGraphClick = (e: React.MouseEvent) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const graphW = rect.width - PADDING_LEFT - PADDING_RIGHT;
    const t = ((x - PADDING_LEFT) / graphW) * dur;
    if (t >= 0 && t <= dur) {
      setPlayhead(clip.startSec + t);
    }
  };

  const width = 600;

  const linePath = points.length >= 2
    ? points.map((p, i) => `${i === 0 ? "M" : "L"} ${tToX(p.t, width)} ${vToY(p.v)}`).join(" ")
    : "";

  const isKf = prop === "volume" ? hasVolumeKfs : hasTransformKfs;

  const ticks = useMemo(() => {
    const result: number[] = [];
    const step = dur <= 2 ? 0.5 : dur <= 10 ? 1 : dur <= 30 ? 5 : 10;
    for (let t = 0; t <= dur; t += step) result.push(t);
    if (result[result.length - 1] < dur - step * 0.1) result.push(dur);
    return result;
  }, [dur]);

  const propMeta = PROPERTIES.find((p) => p.key === prop)!;

  return (
    <div className="px-3 pb-3">
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        {availableProps.map((p) => (
          <button
            key={p.key}
            onClick={() => setProp(p.key)}
            className={[
              "px-2 py-0.5 rounded text-[11px] font-medium transition-colors",
              prop === p.key
                ? "bg-we-teal text-white"
                : "bg-we-hover text-we-muted hover:text-we-ink",
            ].join(" ")}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div
        ref={containerRef}
        className="w-full rounded border border-we-border bg-we-rail overflow-hidden cursor-crosshair"
        onClick={onGraphClick}
      >
        <svg
          viewBox={`0 0 ${width} ${GRAPH_HEIGHT + HEADER_HEIGHT}`}
          className="w-full"
          style={{ height: GRAPH_HEIGHT + HEADER_HEIGHT }}
          preserveAspectRatio="none"
        >
          {/* Time ruler */}
          <g className="text-we-muted">
            {ticks.map((t) => {
              const x = tToX(t, width);
              return (
                <g key={t}>
                  <line x1={x} y1={0} x2={x} y2={GRAPH_HEIGHT + HEADER_HEIGHT} stroke="currentColor" strokeOpacity={0.15} strokeWidth={1} />
                  <text x={x} y={GRAPH_HEIGHT + HEADER_HEIGHT - 6} textAnchor="middle" fill="currentColor" fontSize={9} opacity={0.6}>
                    {t.toFixed(t % 1 === 0 ? 0 : 1)}s
                  </text>
                </g>
              );
            })}
          </g>

          {/* Value grid lines */}
          {[0.25, 0.5, 0.75].map((f) => {
            const y = GRAPH_HEIGHT * (1 - f);
            return (
              <line key={f} x1={PADDING_LEFT} y1={y} x2={width - PADDING_RIGHT} y2={y} stroke="currentColor" strokeOpacity={0.08} strokeWidth={1} className="text-we-muted" />
            );
          })}

          {/* Interpolation line */}
          {linePath && (
            <path
              d={linePath}
              fill="none"
              stroke="var(--we-teal, #1aa6b7)"
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          )}

          {/* Keyframe diamonds */}
          {isKf && points.map((p, i) => {
            const x = tToX(p.t, width);
            const y = vToY(p.v);
            const isAtPlayhead = Math.abs(p.t - localPlayhead) < 0.05;
            return (
              <g key={i}>
                <rect
                  x={x - 5}
                  y={y - 5}
                  width={10}
                  height={10}
                  rx={1}
                  transform={`rotate(45 ${x} ${y})`}
                  fill={isAtPlayhead ? "var(--we-teal, #1aa6b7)" : "#fff"}
                  stroke="var(--we-teal, #1aa6b7)"
                  strokeWidth={1.5}
                  className="cursor-pointer"
                />
                <text
                  x={x}
                  y={y - 10}
                  textAnchor="middle"
                  fill="var(--we-teal, #1aa6b7)"
                  fontSize={8}
                  fontWeight={500}
                  opacity={0.8}
                >
                  {propMeta.format(p.v)}
                </text>
              </g>
            );
          })}

          {/* No-keyframes hint */}
          {!isKf && (
            <text
              x={width / 2}
              y={GRAPH_HEIGHT / 2}
              textAnchor="middle"
              fill="currentColor"
              fontSize={11}
              opacity={0.4}
              className="text-we-muted"
            >
              No {propMeta.label.toLowerCase()} keyframes — flat at {propMeta.format(points[0]?.v ?? 0)}
            </text>
          )}

          {/* Playhead */}
          {localPlayhead >= 0 && localPlayhead <= dur && (
            <line
              x1={tToX(localPlayhead, width)}
              y1={0}
              x2={tToX(localPlayhead, width)}
              y2={GRAPH_HEIGHT + HEADER_HEIGHT}
              stroke="var(--we-teal, #1aa6b7)"
              strokeWidth={1.5}
              strokeDasharray="4 2"
              opacity={0.7}
            />
          )}
        </svg>
      </div>
      <p className="text-[10px] text-we-muted mt-1.5 leading-4">
        Click the graph to move the playhead. Use Properties to add/edit keyframes.
      </p>
    </div>
  );
}

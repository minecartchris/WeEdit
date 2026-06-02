import { useRef } from "react";

// A draggable divider that resizes an adjacent panel. The parent owns the size
// value (from prefs); this just reports new clamped values during the drag and
// fires `onCommit` once on release (so disk writes happen once, not per frame).
//
//   axis "x" → vertical bar, drag left/right to change a WIDTH
//   axis "y" → horizontal bar, drag up/down to change a HEIGHT
//   invert    → the panel being sized is on the opposite side of the drag, so a
//               positive cursor delta should shrink it (e.g. a panel on the
//               right, or the timeline below).

interface Props {
  axis: "x" | "y";
  value: number;
  min: number;
  max: number;
  invert?: boolean;
  onChange: (value: number) => void;
  onCommit?: () => void;
}

export function Splitter({ axis, value, min, max, invert, onChange, onCommit }: Props) {
  // Latch the value at drag start in a ref so mid-drag re-renders don't reset it.
  const startRef = useRef(0);
  const startValRef = useRef(value);

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    startRef.current = axis === "x" ? e.clientX : e.clientY;
    startValRef.current = value;

    const onMove = (ev: PointerEvent) => {
      const cur = axis === "x" ? ev.clientX : ev.clientY;
      let delta = cur - startRef.current;
      if (invert) delta = -delta;
      const next = Math.max(min, Math.min(max, startValRef.current + delta));
      onChange(next);
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      onCommit?.();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const isX = axis === "x";
  return (
    <div
      role="separator"
      aria-orientation={isX ? "vertical" : "horizontal"}
      onPointerDown={onPointerDown}
      className={[
        "shrink-0 group relative z-10 bg-we-border/40 hover:bg-we-teal/50 transition-colors",
        isX ? "w-1 cursor-col-resize" : "h-1 cursor-row-resize",
      ].join(" ")}
    >
      {/* Invisible wider hit area so the 1px bar is easy to grab. */}
      <span
        className={[
          "absolute",
          isX ? "inset-y-0 -left-1 -right-1" : "inset-x-0 -top-1 -bottom-1",
        ].join(" ")}
      />
    </div>
  );
}

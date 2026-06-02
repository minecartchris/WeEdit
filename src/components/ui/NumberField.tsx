// A labelled control pairing a range slider with a typed number input, so a
// value can be dragged roughly or typed exactly. Used by the Inspector for
// position / scale / opacity / volume. Mirrors the slider pattern that used to
// live in the Timeline toolbar (pushHistory on interaction start so a drag is
// one undo entry).

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** Shown after the number (e.g. "%", "px"). */
  suffix?: string;
  /** Decimals for the readout / typed value. Default 0. */
  decimals?: number;
  /** Called once when an edit interaction begins (for history snapshotting). */
  onCommitStart?: () => void;
  onChange: (value: number) => void;
}

export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  suffix,
  decimals = 0,
  onCommitStart,
  onChange,
}: Props) {
  const rounded = Number.isFinite(value) ? Number(value.toFixed(decimals)) : 0;

  const commit = (raw: number) => {
    if (!Number.isFinite(raw)) return;
    onChange(raw);
  };

  return (
    <label className="flex flex-col gap-1 text-xs text-we-ink">
      <span className="text-we-muted">{label}</span>
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Math.min(max, Math.max(min, rounded))}
          onMouseDown={onCommitStart}
          onChange={(e) => commit(parseFloat(e.target.value))}
          className="accent-we-teal flex-1 min-w-0"
        />
        <div className="flex items-center gap-1 shrink-0">
          <input
            type="number"
            step={step}
            value={rounded}
            onFocus={onCommitStart}
            onChange={(e) => commit(parseFloat(e.target.value))}
            className="we-input w-16 px-2 py-1 text-right tabular-nums"
          />
          {suffix && <span className="text-we-muted w-5 text-[10px]">{suffix}</span>}
        </div>
      </div>
    </label>
  );
}

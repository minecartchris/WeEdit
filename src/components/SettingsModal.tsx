import { Monitor, Moon, RotateCcw, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { SHORTCUT_COMMANDS, eventToCombo, formatCombo } from "@/lib/shortcuts";
import { usePrefs } from "@/state/prefs";
import type { PositionUnit, ThemeMode } from "@/types";

// App settings. Appearance (theme) + Editor (position unit) today; the Keyboard
// shortcuts section is added in the shortcuts phase.

interface Props {
  open: boolean;
  onClose: () => void;
}

export function SettingsModal({ open, onClose }: Props) {
  return (
    <Modal open={open} onClose={onClose} title="Settings" width="560px">
      <div className="p-5 flex flex-col gap-7">
        <AppearanceSection />
        <EditorSection />
        <AutosaveSection />
        <ShortcutsSection />
      </div>
    </Modal>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <div>
        <h3 className="text-sm font-semibold text-we-ink">{title}</h3>
        {hint && <p className="text-xs text-we-muted mt-0.5">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

const THEME_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

function AppearanceSection() {
  const theme = usePrefs((s) => s.theme);
  const setTheme = usePrefs((s) => s.setTheme);

  return (
    <Section title="Appearance" hint="Choose a theme. System follows your OS setting.">
      <div className="grid grid-cols-3 gap-2">
        {THEME_OPTIONS.map(({ value, label, icon: Icon }) => {
          const active = theme === value;
          return (
            <button
              key={value}
              onClick={() => setTheme(value)}
              className={[
                "flex flex-col items-center gap-1.5 rounded-lg border px-3 py-3 text-sm transition-colors",
                active
                  ? "border-we-teal bg-we-teal/10 text-we-ink"
                  : "border-we-border text-we-muted hover:bg-we-hover hover:text-we-ink",
              ].join(" ")}
              aria-pressed={active}
            >
              <Icon className={["w-5 h-5", active ? "text-we-teal" : ""].join(" ")} />
              {label}
            </button>
          );
        })}
      </div>
    </Section>
  );
}

function ShortcutsSection() {
  const customShortcuts = usePrefs((s) => s.customShortcuts);
  const setShortcut = usePrefs((s) => s.setShortcut);
  const resetShortcuts = usePrefs((s) => s.resetShortcuts);
  const [recordingId, setRecordingId] = useState<string | null>(null);

  // While recording, the next key press (other than Escape) becomes the binding.
  useEffect(() => {
    if (!recordingId) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setRecordingId(null);
        return;
      }
      const combo = eventToCombo(e);
      if (!combo) return; // lone modifier — keep waiting
      setShortcut(recordingId, combo);
      setRecordingId(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recordingId, setShortcut]);

  return (
    <Section title="Keyboard shortcuts" hint="Click a shortcut to record a new key, or reset to defaults.">
      <div className="flex flex-col divide-y divide-we-border rounded-lg border border-we-border overflow-hidden">
        {SHORTCUT_COMMANDS.map((cmd) => {
          const binding = customShortcuts[cmd.id] ?? cmd.defaultBinding;
          const recording = recordingId === cmd.id;
          const overridden = customShortcuts[cmd.id] != null;
          return (
            <div key={cmd.id} className="flex items-center gap-2 px-3 py-2">
              <span className="flex-1 text-sm text-we-ink">{cmd.label}</span>
              {overridden && !recording && (
                <button
                  onClick={() => setShortcut(cmd.id, null)}
                  className="text-we-muted hover:text-we-ink p-1"
                  title="Reset to default"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
              <button
                onClick={() => setRecordingId(recording ? null : cmd.id)}
                className={[
                  "min-w-[96px] text-center text-xs font-mono rounded px-2 py-1 border transition-colors",
                  recording
                    ? "border-we-teal bg-we-teal/10 text-we-teal animate-pulse"
                    : "border-we-border text-we-ink hover:bg-we-hover",
                ].join(" ")}
              >
                {recording ? "Press keys…" : formatCombo(binding)}
              </button>
            </div>
          );
        })}
      </div>
      <button onClick={resetShortcuts} className="we-btn-ghost self-start text-xs">
        <RotateCcw className="w-3.5 h-3.5" />
        Reset all to defaults
      </button>
    </Section>
  );
}

function Toggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className={[
        "relative h-5 w-9 shrink-0 rounded-full transition-colors",
        on ? "bg-we-teal" : "bg-we-border",
      ].join(" ")}
    >
      <span
        className={[
          "absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white transition-transform",
          on ? "translate-x-4" : "translate-x-0",
        ].join(" ")}
      />
    </button>
  );
}

function NumberField({
  value,
  min,
  max,
  step,
  suffix,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix: string;
  disabled?: boolean;
  onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    const n = Number(draft);
    if (!Number.isFinite(n)) {
      setDraft(String(value));
      return;
    }
    onCommit(Math.max(min, Math.min(max, n)));
  };
  return (
    <div className="flex items-center gap-1.5">
      <input
        type="number"
        min={min}
        max={max}
        step={step ?? 1}
        value={draft}
        disabled={disabled}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
        className="w-16 rounded border border-we-border bg-we-panel px-2 py-1 text-sm text-we-ink text-right disabled:opacity-40"
      />
      <span className="text-xs text-we-muted">{suffix}</span>
    </div>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-sm text-we-ink">{label}</div>
        {hint && <div className="text-[11px] text-we-muted mt-0.5">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function AutosaveSection() {
  const autosave = usePrefs((s) => s.autosave);
  const setAutosave = usePrefs((s) => s.setAutosave);

  return (
    <Section
      title="Auto-save & versions"
      hint="Saving applies once a project has been saved to disk at least once."
    >
      <div className="flex flex-col divide-y divide-we-border rounded-lg border border-we-border overflow-hidden">
        <Row label="Auto-save" hint="Write changes to disk after you stop editing.">
          <Toggle on={autosave.enabled} onChange={(enabled) => setAutosave({ enabled })} />
        </Row>
        <Row label="Save after idle" hint="How long to wait after your last edit.">
          <NumberField
            value={autosave.debounceMs / 1000}
            min={0.25}
            max={30}
            step={0.25}
            suffix="sec"
            disabled={!autosave.enabled}
            onCommit={(v) => setAutosave({ debounceMs: Math.round(v * 1000) })}
          />
        </Row>
        <Row
          label="Keep version history"
          hint="Drop a restorable checkpoint periodically while you work."
        >
          <Toggle
            on={autosave.versionsEnabled}
            onChange={(versionsEnabled) => setAutosave({ versionsEnabled })}
          />
        </Row>
        <Row label="New version every" hint="Minimum time between automatic checkpoints.">
          <NumberField
            value={autosave.versionIntervalMin}
            min={1}
            max={120}
            suffix="min"
            disabled={!autosave.versionsEnabled}
            onCommit={(versionIntervalMin) => setAutosave({ versionIntervalMin })}
          />
        </Row>
      </div>
    </Section>
  );
}

const UNIT_OPTIONS: { value: PositionUnit; label: string; hint: string }[] = [
  { value: "percent", label: "Percent (%)", hint: "Position relative to the frame" },
  { value: "pixels", label: "Pixels (px)", hint: "Position in absolute pixels" },
];

function EditorSection() {
  const unit = usePrefs((s) => s.positionUnit);
  const setUnit = usePrefs((s) => s.setPositionUnit);

  return (
    <Section
      title="Editor"
      hint="Units used for position (X / Y) in the Inspector."
    >
      <div className="grid grid-cols-2 gap-2">
        {UNIT_OPTIONS.map(({ value, label, hint }) => {
          const active = unit === value;
          return (
            <button
              key={value}
              onClick={() => setUnit(value)}
              className={[
                "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2.5 text-left transition-colors",
                active
                  ? "border-we-teal bg-we-teal/10"
                  : "border-we-border hover:bg-we-hover",
              ].join(" ")}
              aria-pressed={active}
            >
              <span className="text-sm font-medium text-we-ink">{label}</span>
              <span className="text-[11px] text-we-muted">{hint}</span>
            </button>
          );
        })}
      </div>
    </Section>
  );
}

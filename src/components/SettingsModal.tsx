import { Monitor, Moon, Sun } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
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

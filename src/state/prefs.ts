import { create } from "zustand";
import { loadConfig, saveConfig } from "@/lib/config";
import type { PanelSizes, PositionUnit, ThemeMode, UiPrefs } from "@/types";

// App-global UI preferences (theme, editor unit, custom shortcuts, panel sizes).
// Distinct from the per-project `editor` store — these persist to config.json
// via lib/config and apply across every project.

const DEFAULT_PANEL_SIZES: PanelSizes = {
  libraryPx: 380,
  inspectorPx: 300,
  timelinePx: 300,
};

const DEFAULTS: UiPrefs = {
  theme: "system",
  positionUnit: "percent",
  customShortcuts: {},
  panelSizes: DEFAULT_PANEL_SIZES,
};

interface PrefsState extends UiPrefs {
  loaded: boolean;
  load: () => Promise<void>;
  setTheme: (theme: ThemeMode) => void;
  setPositionUnit: (unit: PositionUnit) => void;
  setShortcut: (commandId: string, combo: string | null) => void;
  resetShortcuts: () => void;
  /** Live update during a splitter drag — does NOT hit disk. */
  setPanelSize: (key: keyof PanelSizes, px: number) => void;
  /** Persist the current panel sizes (call once on splitter release). */
  savePanelSizes: () => void;
}

// Apply the theme to <html>: toggles the `dark` class Tailwind keys off and
// records the raw mode in data-theme. "system" follows the OS preference.
function applyTheme(theme: ThemeMode) {
  const root = document.documentElement;
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const dark = theme === "dark" || (theme === "system" && prefersDark);
  root.classList.toggle("dark", dark);
  root.dataset.theme = theme;
}

let systemThemeBound = false;
function bindSystemTheme(get: () => PrefsState) {
  if (systemThemeBound) return;
  systemThemeBound = true;
  window
    .matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", () => {
      if (get().theme === "system") applyTheme("system");
    });
}

// Merge a prefs patch into the persisted config without clobbering other keys.
async function persist(patch: Partial<UiPrefs>) {
  try {
    const cfg = await loadConfig();
    await saveConfig({ ...cfg, ui: { ...cfg.ui, ...patch } });
  } catch (err) {
    console.error("Failed to persist UI prefs:", err);
  }
}

export const usePrefs = create<PrefsState>((set, get) => ({
  ...DEFAULTS,
  loaded: false,

  load: async () => {
    bindSystemTheme(get);
    try {
      const cfg = await loadConfig();
      const ui = cfg.ui ?? {};
      const merged: UiPrefs = {
        theme: ui.theme ?? DEFAULTS.theme,
        positionUnit: ui.positionUnit ?? DEFAULTS.positionUnit,
        customShortcuts: ui.customShortcuts ?? {},
        panelSizes: { ...DEFAULT_PANEL_SIZES, ...(ui.panelSizes ?? {}) },
      };
      set({ ...merged, loaded: true });
      applyTheme(merged.theme);
    } catch (err) {
      console.error("Failed to load UI prefs:", err);
      set({ loaded: true });
      applyTheme(get().theme);
    }
  },

  setTheme: (theme) => {
    set({ theme });
    applyTheme(theme);
    void persist({ theme });
  },
  setPositionUnit: (positionUnit) => {
    set({ positionUnit });
    void persist({ positionUnit });
  },
  setShortcut: (commandId, combo) =>
    set((s) => {
      const next = { ...s.customShortcuts };
      if (combo == null || combo === "") delete next[commandId];
      else next[commandId] = combo;
      void persist({ customShortcuts: next });
      return { customShortcuts: next };
    }),
  resetShortcuts: () => {
    set({ customShortcuts: {} });
    void persist({ customShortcuts: {} });
  },
  setPanelSize: (key, px) =>
    set((s) => ({ panelSizes: { ...s.panelSizes, [key]: Math.round(px) } })),
  savePanelSizes: () => void persist({ panelSizes: get().panelSizes }),
}));

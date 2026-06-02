import { newProject, openProject, saveProject } from "@/lib/project";
import { useEditor } from "@/state/editor";

// Central registry of keyboard commands. Each has a stable id, a label for the
// settings UI, a default key combo, and a run() that performs the action.
// useShortcuts matches keydown events against the effective binding
// (user override from prefs, else the default); the Settings panel edits them.

export interface ShortcutCommand {
  id: string;
  label: string;
  defaultBinding: string;
  run: () => void;
}

function jumpToEnd() {
  const { clips, setPlayhead } = useEditor.getState();
  let max = 0;
  for (const c of Object.values(clips)) {
    const end = c.startSec + c.durationSec;
    if (end > max) max = end;
  }
  setPlayhead(max);
}

function stepFrame(dir: 1 | -1) {
  const { playheadSec, project, setPlayhead } = useEditor.getState();
  setPlayhead(playheadSec + dir * (1 / project.fps));
}

export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  { id: "play-pause", label: "Play / pause", defaultBinding: "space", run: () => useEditor.getState().togglePlay() },
  { id: "split", label: "Split at playhead", defaultBinding: "s", run: () => useEditor.getState().splitAtPlayhead() },
  { id: "delete", label: "Delete selection", defaultBinding: "delete", run: () => useEditor.getState().deleteSelected() },
  { id: "undo", label: "Undo", defaultBinding: "ctrl+z", run: () => useEditor.getState().undo() },
  { id: "redo", label: "Redo", defaultBinding: "ctrl+shift+z", run: () => useEditor.getState().redo() },
  { id: "save", label: "Save project", defaultBinding: "ctrl+s", run: () => void saveProject().catch((e) => console.error("Save failed:", e)) },
  { id: "open", label: "Open project", defaultBinding: "ctrl+o", run: () => void openProject().catch((e) => console.error("Open failed:", e)) },
  { id: "new", label: "New project", defaultBinding: "ctrl+n", run: () => newProject() },
  { id: "jump-start", label: "Jump to start", defaultBinding: "home", run: () => useEditor.getState().setPlayhead(0) },
  { id: "jump-end", label: "Jump to end", defaultBinding: "end", run: jumpToEnd },
  { id: "frame-back", label: "Step back one frame", defaultBinding: "arrowleft", run: () => stepFrame(-1) },
  { id: "frame-forward", label: "Step forward one frame", defaultBinding: "arrowright", run: () => stepFrame(1) },
];

// Built-in alternative bindings that map onto a command id. Applied only when a
// combo doesn't match any effective binding, so user overrides still win.
export const SHORTCUT_ALIASES: Record<string, string> = {
  backspace: "delete",
  "ctrl+y": "redo",
};

/** Normalize a keyboard event to a combo string like "ctrl+shift+z" / "space". */
export function eventToCombo(e: KeyboardEvent): string {
  const key = e.key;
  // Ignore lone modifier presses (used while recording a chord).
  if (key === "Control" || key === "Shift" || key === "Alt" || key === "Meta") return "";
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("ctrl");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key === " " ? "space" : key.toLowerCase());
  return parts.join("+");
}

/** Pretty-print a combo for display, e.g. "ctrl+shift+z" → "Ctrl+Shift+Z". */
export function formatCombo(combo: string): string {
  if (!combo) return "Unbound";
  return combo
    .split("+")
    .map((p) => (p === "space" ? "Space" : p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
    .join("+");
}

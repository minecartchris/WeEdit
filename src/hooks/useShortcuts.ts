import { useEffect } from "react";
import { SHORTCUT_ALIASES, SHORTCUT_COMMANDS, eventToCombo } from "@/lib/shortcuts";
import { usePrefs } from "@/state/prefs";

// Global keyboard shortcuts, driven by the command registry + per-user overrides
// from prefs. We bypass them when the user is typing in an input / textarea /
// contenteditable so things like the rename prompt aren't hijacked.
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const combo = eventToCombo(e);
      if (!combo) return;

      const custom = usePrefs.getState().customShortcuts;
      let matched = SHORTCUT_COMMANDS.find(
        (cmd) => (custom[cmd.id] ?? cmd.defaultBinding) === combo,
      );
      // Fall back to built-in aliases (e.g. Backspace = Delete) only if nothing
      // matched the effective bindings.
      if (!matched) {
        const aliasId = SHORTCUT_ALIASES[combo];
        if (aliasId) matched = SHORTCUT_COMMANDS.find((c) => c.id === aliasId);
      }
      if (!matched) return;

      e.preventDefault();
      matched.run();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  return false;
}

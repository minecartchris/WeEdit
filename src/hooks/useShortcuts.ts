import { useEffect } from "react";
import { newProject, openProject, saveProject } from "@/lib/project";
import { useEditor } from "@/state/editor";

// Global keyboard shortcuts. We bypass them when the user is typing in an
// input / textarea / contenteditable so things like the rename prompt aren't
// hijacked.
export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const { undo, redo, deleteSelected, splitAtPlayhead, togglePlay } =
        useEditor.getState();
      const ctrl = e.ctrlKey || e.metaKey;

      if (ctrl && (e.key === "z" || e.key === "Z") && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (
        (ctrl && e.shiftKey && (e.key === "z" || e.key === "Z")) ||
        (ctrl && (e.key === "y" || e.key === "Y"))
      ) {
        e.preventDefault();
        redo();
      } else if (ctrl && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        void saveProject().catch((err) => console.error("Save failed:", err));
      } else if (ctrl && (e.key === "o" || e.key === "O")) {
        e.preventDefault();
        void openProject().catch((err) => console.error("Open failed:", err));
      } else if (ctrl && (e.key === "n" || e.key === "N")) {
        e.preventDefault();
        newProject();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        deleteSelected();
      } else if (e.key === " ") {
        e.preventDefault();
        togglePlay();
      } else if ((e.key === "s" || e.key === "S") && !ctrl) {
        e.preventDefault();
        splitAtPlayhead();
      }
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

import { useEffect } from "react";
import { saveProject } from "@/lib/project";
import { useEditor } from "@/state/editor";

const DEBOUNCE_MS = 1500;

// Debounced auto-save. Watches content slices (project / media / tracks / clips)
// and writes to disk after the user stops editing — but only once `projectPath`
// has been set (i.e. the user has Saved As at least once). Until then the
// project lives in memory and the user must Save explicitly.
export function useAutoSave() {
  useEffect(() => {
    let timer: number | null = null;
    let inFlight = false;

    const unsubscribe = useEditor.subscribe((s, prev) => {
      const contentChanged =
        s.tracks !== prev.tracks ||
        s.clips !== prev.clips ||
        s.media !== prev.media ||
        s.project !== prev.project;
      if (!contentChanged) return;
      if (s.projectPath == null) return;

      if (timer != null) clearTimeout(timer);
      timer = window.setTimeout(async () => {
        timer = null;
        if (inFlight) return;
        inFlight = true;
        try {
          await saveProject();
        } catch (err) {
          console.error("Auto-save failed:", err);
        } finally {
          inFlight = false;
        }
      }, DEBOUNCE_MS);
    });

    return () => {
      unsubscribe();
      if (timer != null) clearTimeout(timer);
    };
  }, []);
}

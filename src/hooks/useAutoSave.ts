import { useEffect } from "react";
import { commitVersion } from "@/lib/history";
import { saveProject, snapshotForFile } from "@/lib/project";
import { useEditor } from "@/state/editor";
import { usePrefs } from "@/state/prefs";

// Debounced auto-save. Watches content slices (project / media / tracks / clips)
// and writes to disk after the user stops editing — but only once `projectPath`
// has been set (i.e. the user has Saved As at least once) and only while the
// autosave preference is enabled.
//
// When auto-versioning is on, a successful auto-save also drops a periodic
// version-history commit (at most once per `versionIntervalMin`) so the user
// builds a restorable timeline of checkpoints without thinking about it.

// Last time we wrote an automatic version commit, per project path. Lives at
// module scope so it survives re-renders but resets naturally on reload.
let lastAutoVersionAt = 0;
let lastAutoVersionPath: string | null = null;

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
      if (!usePrefs.getState().autosave.enabled) return;

      if (timer != null) clearTimeout(timer);
      const { debounceMs } = usePrefs.getState().autosave;
      timer = window.setTimeout(async () => {
        timer = null;
        if (inFlight) return;
        inFlight = true;
        try {
          await saveProject();
          await maybeAutoVersion();
        } catch (err) {
          console.error("Auto-save failed:", err);
        } finally {
          inFlight = false;
        }
      }, Math.max(250, debounceMs));
    });

    return () => {
      unsubscribe();
      if (timer != null) clearTimeout(timer);
    };
  }, []);
}

async function maybeAutoVersion(): Promise<void> {
  const { autosave } = usePrefs.getState();
  if (!autosave.versionsEnabled) return;
  const folder = useEditor.getState().projectPath;
  if (!folder) return;

  // Reset the throttle when the project changes so a freshly opened project can
  // checkpoint immediately rather than inheriting the previous one's clock.
  if (lastAutoVersionPath !== folder) {
    lastAutoVersionPath = folder;
    lastAutoVersionAt = 0;
  }
  const intervalMs = Math.max(1, autosave.versionIntervalMin) * 60_000;
  if (Date.now() - lastAutoVersionAt < intervalMs) return;

  try {
    await commitVersion(folder, snapshotForFile(), "Auto-save", "auto");
    lastAutoVersionAt = Date.now();
  } catch (err) {
    console.error("Auto-version failed:", err);
  }
}

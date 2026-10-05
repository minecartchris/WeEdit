import { useEffect } from "react";
import { create } from "zustand";
import { isTauri } from "@/lib/platform";
import { useEditor } from "@/state/editor";

// Tracks which project media no longer exist on disk (the file was moved,
// renamed or deleted after import). The media bin and timeline render those in
// red with a "Replace file…" action — like an offline clip in Resolve — so the
// user can point the item at the file's new location instead of re-editing.

interface MissingMediaState {
  missingIds: string[];
  setMissing: (ids: string[]) => void;
}

export const useMissingMedia = create<MissingMediaState>((set) => ({
  missingIds: [],
  setMissing: (ids) => set({ missingIds: ids }),
}));

export function useIsMediaMissing(mediaId: string | undefined): boolean {
  return useMissingMedia((s) => (mediaId ? s.missingIds.includes(mediaId) : false));
}

// Only local file paths can go missing; blob:/http(s) sources (web build, stock
// previews) and blank srcs (collab media still syncing) are skipped.
function isLocalPath(src: string): boolean {
  return src !== "" && !/^(blob|https?|data|asset):/i.test(src);
}

export async function checkMissingMedia(): Promise<void> {
  if (!isTauri()) return;
  const { invoke } = await import("@tauri-apps/api/core");
  const media = useEditor.getState().media;
  const missing: string[] = [];
  for (const m of media) {
    if (!isLocalPath(m.src)) continue;
    let exists = true;
    try {
      exists = await invoke<boolean>("path_exists", { path: m.src });
    } catch {
      exists = true; // can't tell — don't flag it
    }
    if (!exists) missing.push(m.id);
  }
  const prev = useMissingMedia.getState().missingIds;
  if (prev.length !== missing.length || prev.some((id, i) => id !== missing[i])) {
    useMissingMedia.getState().setMissing(missing);
  }
}

/**
 * Re-checks media on disk whenever the project's media list changes and when
 * the window regains focus (the usual moment after moving files in Explorer).
 */
export function useMissingMediaWatcher(): void {
  const media = useEditor((s) => s.media);
  useEffect(() => {
    void checkMissingMedia();
  }, [media]);
  useEffect(() => {
    const onFocus = () => void checkMissingMedia();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);
}

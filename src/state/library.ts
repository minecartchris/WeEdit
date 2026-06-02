import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import { importPath } from "@/lib/media";
import type { MediaItem } from "@/types";

// A persistent, app-global media library: files the user uploads once and keeps
// across sessions and projects. Stored as library.json in the app config dir
// (reusing the plain fs commands, like lib/config). Items hold the imported
// MediaItem (name/thumbnail/metadata); dropping one onto the timeline clones it
// into the current project's media with a fresh id.

export type LibraryCategory = "uploads" | "backgrounds" | "extras" | "transitions";

export interface LibraryItem {
  id: string;
  category: LibraryCategory;
  media: MediaItem;
  addedAt: number;
}

interface LibraryFile {
  version: 1;
  items: LibraryItem[];
}

let cachedPath: string | null = null;
async function libraryPath(): Promise<string> {
  if (cachedPath) return cachedPath;
  const dir = await appConfigDir();
  cachedPath = `${dir.replace(/\\/g, "/").replace(/\/$/, "")}/library.json`;
  return cachedPath;
}

async function persist(items: LibraryItem[]) {
  try {
    const path = await libraryPath();
    const file: LibraryFile = { version: 1, items };
    await invoke("write_project_file", { path, content: JSON.stringify(file, null, 2) });
  } catch (err) {
    console.error("Failed to save library:", err);
  }
}

interface LibraryState {
  items: LibraryItem[];
  loaded: boolean;
  busy: boolean;
  load: () => Promise<void>;
  /** Import files from disk and add them to a category. */
  addFiles: (paths: string[], category: LibraryCategory) => Promise<void>;
  removeItem: (id: string) => void;
}

export const useLibrary = create<LibraryState>((set, get) => ({
  items: [],
  loaded: false,
  busy: false,

  load: async () => {
    try {
      const path = await libraryPath();
      const text = await invoke<string>("read_project_file", { path });
      const file = JSON.parse(text) as LibraryFile;
      set({ items: Array.isArray(file.items) ? file.items : [], loaded: true });
    } catch {
      set({ loaded: true }); // no library file yet — first use
    }
  },

  addFiles: async (paths, category) => {
    if (paths.length === 0) return;
    set({ busy: true });
    try {
      const added: LibraryItem[] = [];
      for (const p of paths) {
        try {
          const media = await importPath(p);
          if (media) added.push({ id: crypto.randomUUID(), category, media, addedAt: Date.now() });
        } catch (err) {
          console.warn("Library import failed for", p, err);
        }
      }
      if (added.length > 0) {
        const items = [...get().items, ...added];
        set({ items });
        void persist(items);
      }
    } finally {
      set({ busy: false });
    }
  },

  removeItem: (id) => {
    const items = get().items.filter((i) => i.id !== id);
    set({ items });
    void persist(items);
  },
}));

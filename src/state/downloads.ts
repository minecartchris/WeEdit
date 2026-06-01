import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { importPath } from "@/lib/media";
import { defaultDownloadDir, ytdlpDownload, type ProgressEvent } from "@/lib/ytdlp";
import { useEditor } from "@/state/editor";
import type { MediaItem } from "@/types";

export type DownloadStatus = "starting" | "downloading" | "importing" | "complete" | "error";

export interface DownloadEntry {
  id: string;
  url: string;
  title: string;
  status: DownloadStatus;
  percent: number;
  speed?: string;
  eta?: string;
  filepath?: string;
  error?: string;
  lastLog?: string;
}

interface DownloadsState {
  /** Downloads keyed by the source URL — so a VodCard can look up its own. */
  byUrl: Record<string, DownloadEntry>;

  /**
   * Kick off a yt-dlp download. Returns the imported MediaItem on success so
   * callers (e.g. drag-to-timeline resolvers) can chain into clip creation;
   * returns null on failure or if the URL is already running.
   */
  start: (url: string, title: string, opts?: { audioOnly?: boolean }) => Promise<MediaItem | null>;
  dismiss: (url: string) => void;
}

export const useDownloads = create<DownloadsState>((set, get) => ({
  byUrl: {},

  start: async (url, title, opts) => {
    const existing = get().byUrl[url];
    if (existing && (existing.status === "starting" || existing.status === "downloading" || existing.status === "importing")) {
      return null; // already running
    }

    const downloadId = crypto.randomUUID();
    const outputDir = await defaultDownloadDir();
    const audioOnly = opts?.audioOnly ?? false;

    const entry: DownloadEntry = {
      id: downloadId,
      url,
      title,
      status: "starting",
      percent: 0,
    };
    set((s) => ({ byUrl: { ...s.byUrl, [url]: entry } }));

    let unlisten: UnlistenFn | null = null;
    try {
      unlisten = await listen<ProgressEvent>("ytdlp-progress", (e) => {
        if (e.payload.id !== downloadId) return;
        set((s) => {
          const cur = s.byUrl[url];
          if (!cur) return s;
          return {
            byUrl: {
              ...s.byUrl,
              [url]: {
                ...cur,
                status: cur.status === "starting" ? "downloading" : cur.status,
                percent: e.payload.percent ?? cur.percent,
                speed: e.payload.speed ?? cur.speed,
                eta: e.payload.eta ?? cur.eta,
                lastLog: e.payload.log ?? cur.lastLog,
              },
            },
          };
        });
      });

      const filepath = await ytdlpDownload({ url, outputDir, downloadId, audioOnly });

      // Importing phase — generate thumbnail + metadata, then add to library.
      set((s) => {
        const cur = s.byUrl[url];
        if (!cur) return s;
        return { byUrl: { ...s.byUrl, [url]: { ...cur, status: "importing", percent: 100, filepath } } };
      });

      const item = await importPath(filepath);
      if (item) useEditor.getState().addMedia(item);

      set((s) => {
        const cur = s.byUrl[url];
        if (!cur) return s;
        return { byUrl: { ...s.byUrl, [url]: { ...cur, status: "complete" } } };
      });
      return item;
    } catch (err) {
      set((s) => {
        const cur = s.byUrl[url];
        if (!cur) return s;
        return {
          byUrl: {
            ...s.byUrl,
            [url]: { ...cur, status: "error", error: err instanceof Error ? err.message : String(err) },
          },
        };
      });
      return null;
    } finally {
      if (unlisten) unlisten();
    }
  },

  dismiss: (url) =>
    set((s) => {
      if (!s.byUrl[url]) return s;
      const next = { ...s.byUrl };
      delete next[url];
      return { byUrl: next };
    }),
}));

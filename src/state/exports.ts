import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { create } from "zustand";
import { compileExport, type ExportOptions } from "@/lib/exportFfmpeg";
import { ffmpegCancel, ffmpegRun, type FfmpegExportProgress } from "@/lib/ffmpeg";
import { useEditor } from "@/state/editor";

export type ExportStatus = "idle" | "compiling" | "running" | "complete" | "error" | "cancelled";

export interface ExportJob {
  id: string;
  status: ExportStatus;
  percent: number;
  speed?: string;
  fps?: string;
  etaSec?: number;
  outTimeSec?: number;
  outputPath: string;
  totalDurationSec: number;
  error?: string;
  /** Last few stderr lines, in case the user wants to debug a failed export. */
  log: string[];
}

interface ExportsState {
  active: ExportJob | null;

  start: (opts: ExportOptions) => Promise<void>;
  cancel: () => Promise<void>;
  dismiss: () => void;
}

const LOG_TAIL = 40;

export const useExports = create<ExportsState>((set, get) => ({
  active: null,

  start: async (opts) => {
    const existing = get().active;
    if (existing && (existing.status === "compiling" || existing.status === "running")) {
      return; // one export at a time
    }

    const id = crypto.randomUUID();
    const editorState = useEditor.getState();

    let compiled: ReturnType<typeof compileExport>;
    try {
      set({
        active: {
          id,
          status: "compiling",
          percent: 0,
          outputPath: opts.outputPath,
          totalDurationSec: 0,
          log: [],
        },
      });
      compiled = compileExport(
        {
          project: editorState.project,
          tracks: editorState.tracks,
          clips: editorState.clips,
          media: editorState.media,
        },
        opts,
      );
    } catch (err) {
      set({
        active: {
          id,
          status: "error",
          percent: 0,
          outputPath: opts.outputPath,
          totalDurationSec: 0,
          error: err instanceof Error ? err.message : String(err),
          log: [],
        },
      });
      return;
    }

    set({
      active: {
        id,
        status: "running",
        percent: 0,
        outputPath: opts.outputPath,
        totalDurationSec: compiled.totalDurationSec,
        log: [],
      },
    });

    let unlisten: UnlistenFn | null = null;
    try {
      // ffmpeg won't create the output's parent directory on its own, so do
      // it here. Handles both forward- and back-slash paths on Windows.
      const parentDir = opts.outputPath.replace(/[\\/][^\\/]+$/, "");
      if (parentDir && parentDir !== opts.outputPath) {
        await invoke("ensure_dir", { path: parentDir });
      }

      unlisten = await listen<FfmpegExportProgress>("ffmpeg-progress", (e) => {
        if (e.payload.id !== id) return;
        set((s) => {
          const cur = s.active;
          if (!cur || cur.id !== id) return s;
          const newLog = e.payload.log
            ? [...cur.log, e.payload.log].slice(-LOG_TAIL)
            : cur.log;
          return {
            active: {
              ...cur,
              percent: e.payload.percent ?? cur.percent,
              speed: e.payload.speed ?? cur.speed,
              fps: e.payload.fps ?? cur.fps,
              etaSec: e.payload.etaSec ?? cur.etaSec,
              outTimeSec: e.payload.outTimeSec ?? cur.outTimeSec,
              log: newLog,
            },
          };
        });
      });

      await ffmpegRun({
        args: compiled.args,
        exportId: id,
        totalDurationSec: compiled.totalDurationSec,
      });

      set((s) => {
        const cur = s.active;
        if (!cur || cur.id !== id) return s;
        // If the user cancelled while ffmpeg was running, status will already
        // be "cancelled" — don't overwrite to complete.
        if (cur.status === "cancelled") return s;
        return { active: { ...cur, status: "complete", percent: 1 } };
      });
    } catch (err) {
      set((s) => {
        const cur = s.active;
        if (!cur || cur.id !== id) return s;
        if (cur.status === "cancelled") return s;
        const msg = err instanceof Error ? err.message : String(err);
        return {
          active: {
            ...cur,
            status: "error",
            error: msg,
          },
        };
      });
    } finally {
      if (unlisten) unlisten();
    }
  },

  cancel: async () => {
    const cur = get().active;
    if (!cur) return;
    if (cur.status !== "running" && cur.status !== "compiling") return;
    set({ active: { ...cur, status: "cancelled" } });
    try {
      await ffmpegCancel(cur.id);
    } catch (err) {
      console.warn("ffmpeg_cancel failed:", err);
    }
  },

  dismiss: () => set({ active: null }),
}));

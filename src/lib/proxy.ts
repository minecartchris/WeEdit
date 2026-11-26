import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { useEffect } from "react";
import { create } from "zustand";
import { ffmpegRun, type FfmpegExportProgress } from "@/lib/ffmpeg";
import { isTauri } from "@/lib/platform";
import { useEditor } from "@/state/editor";
import { usePrefs } from "@/state/prefs";
import type { MediaItem } from "@/types";

// Editing copies ("proxies") of big local videos.
//
// Scrubbing and playing a multi-GB 1080p60/4K recording straight off disk makes
// the preview stutter. A 720p H.264 copy with a short keyframe interval decodes
// cheaply and seeks fast, so the preview plays that instead; export always uses
// the original (`src`). The same encoder settings make the "preview copies" sent
// to collaborators, and collaboration reuses an existing local proxy instead of
// encoding again.

/**
 * ffmpeg args for an editing copy: 720p H.264 with a bitrate cap, every audio
 * stream kept (OBS records several and the editor exposes each), a 2-second-ish
 * GOP so scrubbing stays snappy, and the index up front so it plays at once.
 */
export function proxyArgs(src: string, out: string): string[] {
  return [
    "-y",
    "-hide_banner",
    "-i", src,
    "-map", "0:v:0",
    "-map", "0:a?",
    "-sn",
    "-dn",
    "-vf", "scale=-2:min(720\\,ih)",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "26",
    "-maxrate", "3M",
    "-bufsize", "6M",
    "-g", "60",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    out,
  ];
}

/** Videos at least this big, or taller than 1080p, get an editing copy. */
const PROXY_MIN_BYTES = 1024 * 1024 * 1024;
const PROXY_MIN_HEIGHT = 1081;

interface ProxyState {
  /** mediaId -> encode progress 0..1 while an editing copy is being made. */
  building: Record<string, number>;
}
export const useProxies = create<ProxyState>(() => ({ building: {} }));

const attempted = new Set<string>();
let queue: Promise<unknown> = Promise.resolve();

async function needsProxy(m: MediaItem): Promise<boolean> {
  if (m.kind !== "video" || !m.src || m.srcIsProxy) return false;
  if ((m.height ?? 0) >= PROXY_MIN_HEIGHT) return true;
  try {
    return (await invoke<number>("file_size", { path: m.src })) >= PROXY_MIN_BYTES;
  } catch {
    return false;
  }
}

async function buildLocalProxy(m: MediaItem): Promise<void> {
  const base = (await appLocalDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  const dir = `${base}/proxies`;
  const out = `${dir}/${m.id}.mp4`;
  const tmp = `${dir}/${m.id}.tmp.mp4`;
  const setSrc = () =>
    useEditor.setState((s) => ({
      media: s.media.map((x) => (x.id === m.id && x.src === m.src ? { ...x, previewSrc: out } : x)),
    }));

  if (await invoke<boolean>("path_exists", { path: out })) {
    setSrc();
    return;
  }
  await invoke("ensure_dir", { path: dir });
  const id = `localproxy-${m.id}-${Date.now()}`;
  useProxies.setState((s) => ({ building: { ...s.building, [m.id]: 0 } }));
  const unlisten = await listen<FfmpegExportProgress>("ffmpeg-progress", (e) => {
    if (e.payload.id !== id || e.payload.percent == null) return;
    const pct = e.payload.percent;
    useProxies.setState((s) => ({ building: { ...s.building, [m.id]: pct } }));
  });
  try {
    await ffmpegRun({ args: proxyArgs(m.src, tmp), exportId: id, totalDurationSec: m.durationSec ?? 0 });
    await invoke("rename_path", { from: tmp, to: out });
    setSrc();
  } catch (err) {
    console.warn(`Couldn't make an editing copy of ${m.name}:`, err);
    invoke("remove_file", { path: tmp }).catch(() => {});
  } finally {
    unlisten();
    useProxies.setState((s) => {
      const building = { ...s.building };
      delete building[m.id];
      return { building };
    });
  }
}

/** Queue editing copies (one at a time) for big videos in the project. */
function scan(): void {
  if (!usePrefs.getState().useLocalProxies) return;
  for (const m of useEditor.getState().media) {
    if (attempted.has(m.id) || m.kind !== "video" || !m.src || m.srcIsProxy) continue;
    attempted.add(m.id);
    queue = queue
      .then(async () => {
        const current = useEditor.getState().media.find((x) => x.id === m.id);
        if (!current) return;
        if (current.previewSrc && (await invoke<boolean>("path_exists", { path: current.previewSrc }))) return;
        if (await needsProxy(current)) await buildLocalProxy(current);
      })
      .catch((err) => console.warn("proxy queue:", err));
  }
}

/** Keeps editing copies made for the project's big videos (desktop only). */
export function useLocalProxies(): void {
  const enabled = usePrefs((s) => s.useLocalProxies);
  useEffect(() => {
    if (!isTauri() || !enabled) return;
    scan();
    return useEditor.subscribe((s, prev) => {
      if (s.media !== prev.media) scan();
    });
  }, [enabled]);
}

/** The file the preview should play for `m`. */
export function previewPath(m: MediaItem): string {
  if (m.previewSrc && !m.srcIsProxy && usePrefs.getState().useLocalProxies) return m.previewSrc;
  return m.src;
}

import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import { makeClipFromMedia } from "@/lib/clips";
import { importPath } from "@/lib/media";
import { useEditor } from "@/state/editor";
import { useIntegrations } from "@/state/integrations";
import { usePrefs } from "@/state/prefs";
import type { MediaClip } from "@/types";

// Twitch chat for a VOD clip: a rendered chat-replay overlay placed in sync on
// a track above the clip, and timeline markers where chat suddenly got busy
// (a good first pass at finding highlights). Driven through TwitchDownloaderCLI.

export const useTwitchChatDialog = create<{ clipId: string | null; open: (id: string) => void; close: () => void }>(
  (set) => ({
    clipId: null,
    open: (clipId) => set({ clipId }),
    close: () => set({ clipId: null }),
  }),
);

/** A VOD id guessed from a downloaded VOD's file name ("v2312345678", "…[2312345678]"). */
export function guessVodId(name: string): string {
  return name.match(/(?:^|[^0-9])v?(\d{9,12})(?:[^0-9]|$)/)?.[1] ?? "";
}

/** A VOD id from whatever the user pasted: a twitch.tv/videos/… URL or the id. */
export function parseVodId(input: string): string | null {
  const t = input.trim();
  const fromUrl = t.match(/twitch\.tv\/videos\/(\d+)/i)?.[1];
  const id = fromUrl ?? (/^v?\d{6,14}$/.test(t) ? t.replace(/^v/, "") : null);
  return id ?? null;
}

export function findTwitchDownloader(): Promise<string | null> {
  return invoke<string | null>("twitch_downloader_check", {
    customPath: usePrefs.getState().twitchDownloaderPath,
  });
}

interface ChatJson {
  comments?: Array<{ content_offset_seconds?: number }>;
}

/**
 * Busiest moments of the chat, as VOD seconds: 30-second windows whose message
 * count stands well above the stream's norm, strongest first, at most `max`.
 */
export function chatSpikes(chat: ChatJson, max = 12): Array<{ sec: number; count: number }> {
  const WINDOW = 30;
  const offsets = (chat.comments ?? [])
    .map((c) => c.content_offset_seconds)
    .filter((n): n is number => typeof n === "number");
  if (offsets.length < 20) return [];
  const buckets = new Map<number, number>();
  for (const t of offsets) {
    const b = Math.floor(t / WINDOW);
    buckets.set(b, (buckets.get(b) ?? 0) + 1);
  }
  const counts = [...buckets.values()];
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  const sd = Math.sqrt(counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length);
  const threshold = Math.max(mean + 2 * sd, mean * 2, 5);
  const spikes = [...buckets.entries()]
    .filter(([, n]) => n >= threshold)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max);
  // Skip a spike right next to a stronger one (they're usually the same moment).
  const picked: Array<{ sec: number; count: number }> = [];
  for (const [b, n] of spikes) {
    if (picked.some((p) => Math.abs(p.sec - b * WINDOW) < 90)) continue;
    picked.push({ sec: b * WINDOW, count: n });
  }
  return picked;
}

export interface ChatJobOptions {
  vodId: string;
  overlay: boolean;
  highlights: boolean;
  onStatus?: (text: string) => void;
}

/** Run the chat tools for a VOD clip. Returns a short summary for the user. */
export async function runTwitchChat(clipId: string, opts: ChatJobOptions): Promise<string> {
  const ed = useEditor.getState();
  const clip = ed.clips[clipId] as MediaClip | undefined;
  if (!clip || clip.kind !== "video") throw new Error("Pick a video clip of the VOD.");
  const speed = clip.speed ?? 1;
  const begin = clip.sourceInSec;
  const end = clip.sourceInSec + clip.durationSec * speed;
  // VOD time -> timeline time for this clip.
  const toTimeline = (vodSec: number) => clip.startSec + (vodSec - clip.sourceInSec) / speed;

  const base = (await appLocalDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  const stem = `${base}/twitch-chat/${opts.vodId}-${Math.floor(begin)}-${Math.ceil(end)}`;
  const jsonPath = `${stem}.json`;
  const tool = usePrefs.getState().twitchDownloaderPath;

  opts.onStatus?.("Downloading chat…");
  if (!(await invoke<boolean>("path_exists", { path: jsonPath }))) {
    await invoke("twitch_chat_download", {
      vodId: opts.vodId,
      beginSec: begin,
      endSec: end,
      outputPath: jsonPath,
      customPath: tool,
    });
  }
  const summary: string[] = [];

  if (opts.highlights) {
    const chat = JSON.parse(await invoke<string>("read_project_file", { path: jsonPath })) as ChatJson;
    const spikes = chatSpikes(chat).filter((s) => s.sec >= begin && s.sec <= end);
    useEditor.getState().addMarkers(
      spikes.map((s) => ({
        // Start a little before the burst: chat reacts after the moment.
        sec: Math.max(clip.startSec, toTimeline(s.sec - 15)),
        label: `Chat spike · ${s.count} msgs`,
        color: "#9146ff",
      })),
    );
    summary.push(spikes.length ? `Marked ${spikes.length} chat spikes` : "No standout chat spikes");
  }

  if (opts.overlay) {
    opts.onStatus?.("Rendering the chat overlay (this takes a while for long clips)…");
    const videoPath = `${stem}.mp4`;
    await invoke("twitch_chat_render", {
      inputPath: jsonPath,
      outputPath: videoPath,
      width: 400,
      height: 900,
      customPath: tool,
      ffmpegCustomPath: useIntegrations.getState().ffmpegPath,
    });
    opts.onStatus?.("Adding the overlay to the timeline…");
    const item = await importPath(videoPath);
    if (!item) throw new Error("Couldn't import the rendered chat video.");
    const state = useEditor.getState();
    state.addMedia({ ...item, name: `Chat · ${opts.vodId}` });
    const trackId = state.addTrack("video"); // new tracks go on top of the stack
    state.renameTrack(trackId, "Chat replay");
    const overlay = makeClipFromMedia(item, trackId, clip.startSec) as MediaClip;
    useEditor.getState().addClip({
      ...overlay,
      // Same speed as the stream clip so chat stays in step with it.
      speed: clip.speed,
      durationSec: Math.min(overlay.durationSec / speed, clip.durationSec),
      // Bottom-right, a third of the frame — move/resize it on the stage.
      xPct: 86,
      yPct: 60,
      scale: 0.38,
      volume: 0,
    });
    summary.push("added the chat overlay on a new track");
  }
  return summary.join(", ") + ".";
}

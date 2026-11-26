import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { create } from "zustand";
import { useEditor } from "@/state/editor";
import { useIntegrations } from "@/state/integrations";
import { usePrefs } from "@/state/prefs";
import type { MediaClip, MediaItem, TextClip } from "@/types";

// Timeline tools that analyse a clip's audio: Remove silence and Auto-captions.
// Both run natively (ffmpeg silencedetect / whisper.cpp), desktop only.

/** Which tool dialog is open, and for which clips. */
interface ToolsState {
  silenceFor: string[] | null;
  captionsFor: string[] | null;
  openSilence: (clipIds: string[]) => void;
  openCaptions: (clipIds: string[]) => void;
  close: () => void;
}
export const useTools = create<ToolsState>((set) => ({
  silenceFor: null,
  captionsFor: null,
  openSilence: (clipIds) => set({ silenceFor: clipIds, captionsFor: null }),
  openCaptions: (clipIds) => set({ captionsFor: clipIds, silenceFor: null }),
  close: () => set({ silenceFor: null, captionsFor: null }),
}));

const ffmpegPath = () => useIntegrations.getState().ffmpegPath;

/** The audio-bearing media clips among `ids`, with their media. */
export function audioClips(ids: string[]): Array<{ clip: MediaClip; media: MediaItem }> {
  const { clips, media } = useEditor.getState();
  const out: Array<{ clip: MediaClip; media: MediaItem }> = [];
  for (const id of ids) {
    const c = clips[id];
    if (!c || (c.kind !== "video" && c.kind !== "audio")) continue;
    const m = media.find((x) => x.id === (c as MediaClip).mediaId);
    if (m?.src) out.push({ clip: c as MediaClip, media: m });
  }
  return out;
}

// ── Remove silence ───────────────────────────────────────────────────────────

export interface SilenceOptions {
  /** Quieter than this counts as silence, in dB (e.g. -35). */
  noiseDb: number;
  /** Only pauses at least this long are removed, in seconds. */
  minSilenceSec: number;
  /** Breathing room kept at each side of a cut, in seconds. */
  paddingSec: number;
}

export const DEFAULT_SILENCE: SilenceOptions = { noiseDb: -35, minSilenceSec: 0.6, paddingSec: 0.15 };

/**
 * Silent stretches of the given clips, as TIMELINE ranges ready for
 * `rippleDeleteRanges` (padding already applied, overlaps merged by the store).
 */
export async function detectSilence(ids: string[], opts: SilenceOptions): Promise<Array<[number, number]>> {
  const ranges: Array<[number, number]> = [];
  for (const { clip, media } of audioClips(ids)) {
    const speed = clip.speed ?? 1;
    const found = await invoke<Array<[number, number]>>("ffmpeg_detect_silence", {
      sourcePath: media.src,
      startSec: clip.sourceInSec,
      durationSec: clip.durationSec * speed,
      noiseDb: opts.noiseDb,
      minSilenceSec: opts.minSilenceSec,
      customPath: ffmpegPath(),
    });
    for (const [a, b] of found) {
      const start = clip.startSec + a / speed + opts.paddingSec;
      const end = Math.min(clip.startSec + clip.durationSec, clip.startSec + b / speed) - opts.paddingSec;
      if (end - start >= 0.1) ranges.push([start, end]);
    }
  }
  return ranges;
}

// ── Auto-captions ────────────────────────────────────────────────────────────

/** whisper.cpp's multilingual "base" model: small, quick, decent accuracy. */
export const CAPTION_MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin";
export const CAPTION_MODEL_MB = 148;

export async function captionModelPath(): Promise<string> {
  const base = (await appLocalDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  return `${base}/whisper/ggml-base.bin`;
}

export async function captionModelReady(): Promise<boolean> {
  try {
    return await invoke<boolean>("path_exists", { path: await captionModelPath() });
  } catch {
    return false;
  }
}

export async function downloadCaptionModel(): Promise<void> {
  await invoke("http_download", { url: CAPTION_MODEL_URL, outputPath: await captionModelPath() });
}

/** Path of the whisper.cpp CLI that will be used, or null if none is found. */
export function findWhisper(): Promise<string | null> {
  return invoke<string | null>("whisper_check", { whisperPath: usePrefs.getState().whisperPath });
}

interface WhisperJson {
  transcription?: Array<{ offsets?: { from: number; to: number }; text?: string }>;
}

/**
 * Transcribe the clips and drop the result onto a new "Captions" text track,
 * one text clip per caption line, timed to the timeline. Returns the count.
 */
export async function generateCaptions(ids: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
  const targets = audioClips(ids);
  const model = await captionModelPath();
  const lines: Array<{ start: number; end: number; text: string }> = [];

  for (let i = 0; i < targets.length; i++) {
    onProgress?.(i, targets.length);
    const { clip, media } = targets[i];
    const speed = clip.speed ?? 1;
    const json = await invoke<string>("whisper_transcribe", {
      sourcePath: media.src,
      startSec: clip.sourceInSec,
      durationSec: clip.durationSec * speed,
      modelPath: model,
      language: usePrefs.getState().captionLanguage || "auto",
      whisperPath: usePrefs.getState().whisperPath,
      customPath: ffmpegPath(),
    });
    const parsed = JSON.parse(json) as WhisperJson;
    for (const seg of parsed.transcription ?? []) {
      const text = (seg.text ?? "").trim();
      if (!text || !seg.offsets || /^\[.*\]$/.test(text)) continue; // skip "[BLANK_AUDIO]" etc.
      const start = clip.startSec + seg.offsets.from / 1000 / speed;
      const end = Math.min(clip.startSec + clip.durationSec, clip.startSec + seg.offsets.to / 1000 / speed);
      if (end - start > 0.05) lines.push({ start, end, text });
    }
  }
  onProgress?.(targets.length, targets.length);
  if (lines.length === 0) return 0;

  const editor = useEditor.getState();
  const trackId = editor.addTrack("text");
  editor.renameTrack?.(trackId, "Captions");
  const captionClips: TextClip[] = lines
    .sort((a, b) => a.start - b.start)
    .map((l, i, all) => ({
      id: crypto.randomUUID(),
      trackId,
      // Never overlap the next caption on the same track.
      startSec: l.start,
      durationSec: Math.max(0.2, Math.min(l.end, all[i + 1]?.start ?? l.end) - l.start),
      sourceInSec: 0,
      kind: "text",
      text: l.text,
      fontFamily: "Inter, system-ui, sans-serif",
      fontSizePx: 44,
      color: "#ffffff",
      xPct: 50,
      yPct: 86,
      scale: 1,
      rotation: 0,
      tilt: 0,
    }));
  useEditor.getState().insertClips(captionClips);
  return captionClips.length;
}

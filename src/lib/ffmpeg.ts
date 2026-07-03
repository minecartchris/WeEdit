import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { useIntegrations } from "@/state/integrations";

// Wrappers for the Rust ffmpeg/ffprobe commands. Every wrapper threads the
// user-configured ffmpeg path (if any) through so the Rust binary lookup
// honors it. Used by `importPath()` for multi-track audio detection +
// extraction, and by the export pipeline to render the timeline.

interface RawAudioStreamInfo {
  index: number;
  codec?: string;
  channels?: number;
  language?: string;
  title?: string;
}

interface ProbeResult {
  audioStreams: RawAudioStreamInfo[];
}

interface ExtractedTrack {
  index: number;
  filepath: string;
}

export interface AudioStreamInfo {
  index: number;
  codec?: string;
  channels?: number;
  language?: string;
  title?: string;
}

function customPath(): string | null {
  return useIntegrations.getState().ffmpegPath;
}

export type FfmpegCheck =
  | { found: true; version: string }
  | { found: false; error: string };

/** Returns ffmpeg's first version line if reachable, else a typed error. */
export async function checkFfmpeg(): Promise<FfmpegCheck> {
  try {
    const version = await invoke<string>("ffmpeg_check", { customPath: customPath() });
    return { found: true, version };
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Actually tries to encode a frame with h264_nvenc rather than just checking
 * whether ffmpeg was compiled with NVENC support — a machine can have that
 * and still lack a GPU/driver that can run it, which is the failure this
 * guards against. Used to avoid defaulting exports to a codec that can't
 * actually run on this machine. Resolves to false (never throws) on any
 * failure, since "not available" is exactly the informative result here.
 */
export async function checkNvenc(): Promise<boolean> {
  try {
    return await invoke<boolean>("ffmpeg_nvenc_available", { customPath: customPath() });
  } catch {
    return false;
  }
}

/**
 * Returns the audio streams found in a media file via ffprobe. Throws if
 * ffprobe isn't installed — caller should fall back to assuming single-track.
 */
export async function ffprobeAudioStreams(path: string): Promise<AudioStreamInfo[]> {
  const result = await invoke<ProbeResult>("ffprobe_audio_streams", {
    path,
    customPath: customPath(),
  });
  return result.audioStreams;
}

/**
 * Extracts each audio track to its own m4a file via `ffmpeg -c copy` (lossless,
 * fast — no transcoding). Returns the extracted filepaths keyed by stream index.
 *
 * The output dir is `<appLocalData>/audio-tracks/<mediaId>/` so extracted
 * tracks ship with the user's WeEdit install rather than polluting their
 * media folders.
 */
export async function extractAudioTracks(args: {
  sourcePath: string;
  mediaId: string;
  trackCount: number;
}): Promise<ExtractedTrack[]> {
  const localData = await appLocalDataDir();
  const dir = `${localData.replace(/\\/g, "/").replace(/\/$/, "")}/audio-tracks/${args.mediaId}`;
  return invoke<ExtractedTrack[]>("ffmpeg_extract_audio_tracks", {
    sourcePath: args.sourcePath,
    outputDir: dir,
    trackCount: args.trackCount,
    customPath: customPath(),
  });
}

// ── Export ──

export interface FfmpegExportProgress {
  id: string;
  percent?: number;
  speed?: string;
  fps?: string;
  etaSec?: number;
  outTimeSec?: number;
  log?: string;
  done: boolean;
  error?: string;
}

export async function ffmpegRun(args: {
  args: string[];
  exportId: string;
  totalDurationSec: number;
}): Promise<void> {
  await invoke("ffmpeg_run", { ...args, customPath: customPath() });
}

export async function ffmpegCancel(exportId: string): Promise<void> {
  await invoke("ffmpeg_cancel", { exportId });
}

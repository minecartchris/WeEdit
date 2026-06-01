import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";

// Wrappers for the Rust ffmpeg/ffprobe commands. Used by `importPath()` to
// detect + extract multi-track audio at import time, and by the export
// pipeline to render the timeline to mp4.

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

/**
 * Returns the audio streams found in a media file via ffprobe. Throws if
 * ffprobe isn't installed — caller should fall back to assuming single-track.
 */
export async function ffprobeAudioStreams(path: string): Promise<AudioStreamInfo[]> {
  const result = await invoke<ProbeResult>("ffprobe_audio_streams", { path });
  return result.audioStreams;
}

/**
 * Extracts each audio track to its own m4a file via `ffmpeg -c copy` (lossless,
 * fast — no transcoding). Returns the extracted filepaths keyed by stream index.
 *
 * The output dir is `<appLocalData>/audio-tracks/<mediaId>/` so extracted
 * tracks ship with the user's WeEdit install rather than polluting their
 * media folders. (They survive across project file moves.)
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
  await invoke("ffmpeg_run", args);
}

export async function ffmpegCancel(exportId: string): Promise<void> {
  await invoke("ffmpeg_cancel", { exportId });
}

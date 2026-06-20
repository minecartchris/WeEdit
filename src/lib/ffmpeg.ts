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

// ── Waveform peaks ──

export interface WaveformPeaksResult {
  peaks: Float32Array;
  bucketsPerSec: number;
}

/**
 * Computes peak-amplitude waveform data for `sourcePath` by decoding through
 * ffmpeg (same demux/decode pipeline as export/playback), instead of the
 * browser's `decodeAudioData`. See the Rust-side `ffmpeg_waveform_peaks` doc
 * comment for why: decodeAudioData can leave a container's leading
 * encoder-delay samples in, which visually shows up as the waveform's peaks
 * starting later than the audio is actually heard.
 */
export async function ffmpegWaveformPeaks(args: {
  sourcePath: string;
  targetBucketsPerSec: number;
}): Promise<WaveformPeaksResult> {
  const result = await invoke<{ peaks: number[]; bucketsPerSec: number }>(
    "ffmpeg_waveform_peaks",
    {
      sourcePath: args.sourcePath,
      targetBucketsPerSec: args.targetBucketsPerSec,
      customPath: customPath(),
    },
  );
  return { peaks: Float32Array.from(result.peaks), bucketsPerSec: result.bucketsPerSec };
}

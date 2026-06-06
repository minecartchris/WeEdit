import { isTauri } from "@/lib/platform";
import { extractAudioTracks, ffprobeAudioStreams } from "@/lib/ffmpeg";
import type { AudioTrackInfo, MediaItem, MediaKind } from "@/types";

const VIDEO_EXT = ["mp4", "mkv", "mov", "webm", "avi", "ts", "m4v"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const AUDIO_EXT = ["mp3", "wav", "ogg", "m4a", "flac", "aac"];

export const SUPPORTED_EXT = [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT];

export function classifyByExt(filename: string): MediaKind | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  return null;
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Opens the OS file picker; returns absolute paths the user selected (Tauri only). */
export async function pickMediaFiles(): Promise<string[]> {
  const { open } = await import("@tauri-apps/plugin-dialog");
  const result = await open({
    multiple: true,
    filters: [
      { name: "All media", extensions: SUPPORTED_EXT },
      { name: "Video",     extensions: VIDEO_EXT },
      { name: "Image",     extensions: IMAGE_EXT },
      { name: "Audio",     extensions: AUDIO_EXT },
    ],
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

let _convertFileSrc: ((path: string) => string) | null = null;

/**
 * Resolves a MediaItem.src to a URL the browser can play. On Tauri this
 * converts a local path via the asset protocol; on web the src is already a
 * blob: or http: URL so we return it as-is.
 */
export function toPlayableUrl(src: string): string {
  if (!isTauri()) return src;
  if (!_convertFileSrc) {
    throw new Error("convertFileSrc not loaded — call initTauriMedia() first");
  }
  return _convertFileSrc(src);
}

export async function initTauriMedia() {
  if (!isTauri()) return;
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  _convertFileSrc = convertFileSrc;
}

const ACCEPT = SUPPORTED_EXT.map((e) => `.${e}`).join(",");

/** Opens the browser file picker; returns File objects the user selected. */
export function pickMediaFilesWeb(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.accept = ACCEPT;
    input.onchange = () => {
      resolve(input.files ? Array.from(input.files) : []);
    };
    input.click();
  });
}

/** Import a browser File into a MediaItem using object URLs. */
export async function importFile(file: File): Promise<MediaItem | null> {
  const name = file.name;
  const kind = classifyByExt(name);
  if (!kind) return null;

  const id = crypto.randomUUID();
  const url = URL.createObjectURL(file);

  if (kind === "video") return probeVideo(id, name, url, url);
  if (kind === "image") return probeImage(id, name, url, url);
  return probeAudio(id, name, url, url);
}

/**
 * Imports a file from disk into a MediaItem with thumbnail + metadata.
 *
 * - For videos: HTML5 video element for duration/dimensions/thumbnail, then
 *   ffprobe to detect multiple audio streams. If >1 audio stream, ffmpeg
 *   extracts each to its own file so PreviewStage can mute them individually.
 *   ffmpeg/ffprobe are best-effort — missing binaries means single-track only.
 */
export async function importPath(path: string): Promise<MediaItem | null> {
  const name = basename(path);
  const kind = classifyByExt(name);
  if (!kind) return null;

  const id = crypto.randomUUID();
  const { convertFileSrc } = await import("@tauri-apps/api/core");
  const url = convertFileSrc(path);

  if (kind === "video") {
    const base = await probeVideo(id, name, path, url);
    const tracks = await detectAndExtractAudioTracks(id, path);
    if (tracks && tracks.length > 1) base.audioTracks = tracks;
    return base;
  }
  if (kind === "image") return probeImage(id, name, path, url);
  return probeAudio(id, name, path, url);
}

async function detectAndExtractAudioTracks(
  mediaId: string,
  sourcePath: string,
): Promise<AudioTrackInfo[] | null> {
  try {
    const streams = await ffprobeAudioStreams(sourcePath);
    if (streams.length <= 1) return null; // single-track muxed audio is fine as-is
    const extracted = await extractAudioTracks({
      sourcePath,
      mediaId,
      trackCount: streams.length,
    });
    // Merge ffprobe metadata with extracted filepaths by index.
    const byIndex = new Map(extracted.map((e) => [e.index, e.filepath]));
    return streams.map((s) => ({
      index: s.index,
      codec: s.codec,
      channels: s.channels,
      language: s.language,
      title: s.title,
      filepath: byIndex.get(s.index) ?? "",
      muted: false,
    }));
  } catch (err) {
    // ffmpeg/ffprobe missing or extraction failed — degrade to single-track.
    console.warn(`Multi-track audio probe failed for ${sourcePath}:`, err);
    return null;
  }
}

function probeVideo(
  id: string,
  name: string,
  path: string,
  url: string,
): Promise<MediaItem> {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.preload = "metadata";
    v.muted = true;
    (v as HTMLVideoElement).playsInline = true;
    v.crossOrigin = "anonymous";
    v.style.position = "fixed";
    v.style.left = "-9999px";
    document.body.appendChild(v);

    const cleanup = () => v.remove();

    const captureThumb = () => {
      try {
        const tw = 320;
        const th = Math.max(1, Math.round(tw * (v.videoHeight / v.videoWidth)));
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext("2d");
        let dataUrl: string | undefined;
        if (ctx) {
          ctx.drawImage(v, 0, 0, tw, th);
          try {
            dataUrl = canvas.toDataURL("image/jpeg", 0.7);
          } catch {
            // Canvas tainted (CORS) — fall through with no thumbnail.
            dataUrl = undefined;
          }
        }
        resolve({
          id,
          name,
          kind: "video",
          src: path,
          durationSec: v.duration,
          width: v.videoWidth,
          height: v.videoHeight,
          thumbnail: dataUrl,
          importedAt: Date.now(),
        });
      } finally {
        cleanup();
      }
    };

    v.addEventListener(
      "loadedmetadata",
      () => {
        const target = Math.min(v.duration * 0.1, 2);
        v.currentTime = target;
      },
      { once: true },
    );
    v.addEventListener("seeked", captureThumb, { once: true });
    v.addEventListener(
      "error",
      () => {
        cleanup();
        reject(new Error(`Failed to load video: ${name}`));
      },
      { once: true },
    );

    v.src = url;
  });
}

function probeImage(
  id: string,
  name: string,
  path: string,
  url: string,
): Promise<MediaItem> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const tw = 320;
        const th = Math.max(1, Math.round(tw * (img.naturalHeight / img.naturalWidth)));
        const canvas = document.createElement("canvas");
        canvas.width = tw;
        canvas.height = th;
        const ctx = canvas.getContext("2d");
        let dataUrl: string | undefined;
        if (ctx) {
          ctx.drawImage(img, 0, 0, tw, th);
          try {
            dataUrl = canvas.toDataURL("image/jpeg", 0.8);
          } catch {
            dataUrl = undefined;
          }
        }
        resolve({
          id,
          name,
          kind: "image",
          src: path,
          width: img.naturalWidth,
          height: img.naturalHeight,
          thumbnail: dataUrl,
          importedAt: Date.now(),
        });
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${name}`));
    img.src = url;
  });
}

function probeAudio(
  id: string,
  name: string,
  path: string,
  url: string,
): Promise<MediaItem> {
  return new Promise((resolve, reject) => {
    const a = document.createElement("audio");
    a.preload = "metadata";
    a.crossOrigin = "anonymous";
    a.addEventListener(
      "loadedmetadata",
      () => {
        resolve({
          id,
          name,
          kind: "audio",
          src: path,
          durationSec: a.duration,
          importedAt: Date.now(),
        });
      },
      { once: true },
    );
    a.addEventListener(
      "error",
      () => reject(new Error(`Failed to load audio: ${name}`)),
      { once: true },
    );
    a.src = url;
  });
}

import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { useEditor } from "@/state/editor";
import { useIntegrations } from "@/state/integrations";

// Frontend wrapper for the Rust ytdlp_check / ytdlp_download commands.
// Listening to progress events is the caller's job — see useDownloads.

export interface ProgressEvent {
  id: string;
  percent?: number;
  speed?: string;
  eta?: string;
  log?: string;
}

export type YtDlpCheck =
  | { found: true; version: string }
  | { found: false; error: string };

/**
 * Returns the installed yt-dlp version, or null if it isn't accessible. Tries
 * (in order): user-configured path → PATH → known winget locations.
 */
export async function checkYtDlp(): Promise<YtDlpCheck> {
  const customPath = useIntegrations.getState().ytdlpPath;
  try {
    const version = await invoke<string>("ytdlp_check", { customPath });
    return { found: true, version };
  } catch (err) {
    return { found: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Runs yt-dlp against the given URL. Resolves to the absolute path of the
 * downloaded file on success. Progress events are emitted to the `ytdlp-progress`
 * Tauri event channel — subscribe via `listen()` and filter by `id`.
 *
 * `audioOnly` switches yt-dlp to fetch the best audio-only stream (m4a/mp3
 * preferred) without invoking ffmpeg for conversion — useful for music URLs
 * (NCS YouTube, SoundCloud, etc).
 */
export async function ytdlpDownload(args: {
  url: string;
  outputDir: string;
  downloadId: string;
  audioOnly?: boolean;
}): Promise<string> {
  const customPath = useIntegrations.getState().ytdlpPath;
  return invoke<string>("ytdlp_download", {
    ...args,
    customPath,
    audioOnly: args.audioOnly ?? false,
  });
}

/**
 * Chooses where downloads land. Project folder if the project has been saved
 * (so the downloads ship alongside the project), otherwise Documents/WeEdit Downloads.
 */
export async function defaultDownloadDir(): Promise<string> {
  const projectPath = useEditor.getState().projectPath;
  if (projectPath) return `${projectPath}/downloads`;
  const docs = await documentDir();
  return join(docs, "WeEdit Downloads");
}

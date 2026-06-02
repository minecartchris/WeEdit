import { invoke } from "@tauri-apps/api/core";
import { appConfigDir } from "@tauri-apps/api/path";
import type { UiPrefs } from "@/types";

// App-wide config persisted to %APPDATA%/com.weedit.app/config.json on Windows
// (or the equivalent per OS). Twitch tokens + saved NAS connections live here.
//
// We reuse the existing Rust fs commands (read_project_file / write_project_file)
// so we don't have to dance with the fs-plugin scope system for app data.

export interface AppConfig {
  version: 1;
  twitch?: TwitchConfig;
  nasConnections?: NasConnection[];
  /** Absolute path to yt-dlp.exe if the user picked one manually. */
  ytdlpPath?: string;
  /** Absolute path to ffmpeg.exe if the user picked one manually. */
  ffmpegPath?: string;
  /** Pexels API key for stock photo / video search. */
  pexelsApiKey?: string;
  /** Freesound API key for SFX + sound effect search. */
  freesoundApiKey?: string;
  /** Jamendo client ID for music track search. */
  jamendoApiKey?: string;
  /** Most-recently-opened .weedit project folders, newest first, max 10. */
  recentProjects?: string[];
  /** App-global UI preferences (theme, position unit, shortcuts, panel sizes). */
  ui?: Partial<UiPrefs>;
}

export interface TwitchConfig {
  clientId: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  userId?: string;
  login?: string;
  displayName?: string;
  profileImageUrl?: string;
}

export interface NasConnection {
  id: string;
  name: string;
  host: string;
  share: string;
  username?: string;
  /** Plaintext for now — Windows already trusts the user; future: DPAPI. */
  password?: string;
  /** Optional subpath inside share to default browsing to. */
  defaultPath?: string;
}

let cachedPath: string | null = null;

async function getConfigPath(): Promise<string> {
  if (cachedPath) return cachedPath;
  const dir = await appConfigDir();
  cachedPath = `${dir.replace(/\\/g, "/").replace(/\/$/, "")}/config.json`;
  return cachedPath;
}

export async function loadConfig(): Promise<AppConfig> {
  const path = await getConfigPath();
  try {
    const text = await invoke<string>("read_project_file", { path });
    const data = JSON.parse(text) as AppConfig;
    if (data.version !== 1) {
      console.warn(`Unexpected config version ${data.version}; using defaults`);
      return { version: 1 };
    }
    return data;
  } catch {
    // File doesn't exist yet — first launch.
    return { version: 1 };
  }
}

export async function saveConfig(config: AppConfig): Promise<void> {
  const path = await getConfigPath();
  await invoke("write_project_file", {
    path,
    content: JSON.stringify(config, null, 2),
  });
}

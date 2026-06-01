// NoCopyrightSounds search via yt-dlp's flat-playlist extractor.
//
// NCS has no public API and the community-maintained ones are unreliable, so
// we go through their official YouTube channel instead:
// https://www.youtube.com/@NoCopyrightSounds
//
// yt-dlp can hit the channel's `?search?query=` URL and return video metadata
// without downloading anything. Free, reliable, and uses tooling the user
// already has installed for Twitch VOD downloads.

import { invoke } from "@tauri-apps/api/core";
import { useIntegrations } from "@/state/integrations";

interface RawYtdlpResult {
  id: string;
  title: string;
  duration: number | null;
  uploader: string | null;
}

export interface NcsTrack {
  id: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnail: string;
  youtubeUrl: string;
}

const NCS_CHANNEL_HANDLE = "NoCopyrightSounds";

export async function searchNcs(query: string, limit = 18): Promise<NcsTrack[]> {
  const customPath = useIntegrations.getState().ytdlpPath;
  const raw = await invoke<RawYtdlpResult[]>("ytdlp_search", {
    customPath,
    channelHandle: NCS_CHANNEL_HANDLE,
    query,
    limit,
  });

  return raw
    .filter((r) => r.id && r.title)
    .map((r) => ({
      id: r.id,
      title: r.title,
      // The channel uploader is "NoCopyrightSounds" — actual artist names are
      // in the video title (typically "Artist - Track [NCS Release]"). Best
      // effort: try to split on " - " if present.
      artist: extractArtist(r.title) || r.uploader || "NoCopyrightSounds",
      durationSec: r.duration ?? 0,
      thumbnail: `https://i.ytimg.com/vi/${r.id}/mqdefault.jpg`,
      youtubeUrl: `https://www.youtube.com/watch?v=${r.id}`,
    }));
}

function extractArtist(title: string): string | null {
  // NCS titles are commonly "Artist - Track Name [NCS Release]" or similar.
  const idx = title.indexOf(" - ");
  if (idx === -1 || idx > 60) return null;
  return title.slice(0, idx).trim();
}

export function ncsTrackTitle(title: string): string {
  // Strip the "Artist - " prefix and trailing "[NCS Release]" cruft for display.
  let t = title;
  const dash = t.indexOf(" - ");
  if (dash !== -1 && dash <= 60) t = t.slice(dash + 3);
  t = t.replace(/\s*\[NCS[^\]]*\]\s*/i, "").trim();
  return t || title;
}

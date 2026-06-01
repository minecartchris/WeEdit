// Jamendo Music API v3.0. Free `client_id` (token in URL). Returns direct MP3
// URLs for full tracks. Docs: https://developer.jamendo.com/v3.0

const JAMENDO_API = "https://api.jamendo.com/v3.0";

export interface JamendoTrack {
  id: string;
  name: string;
  artist_name: string;
  duration: number; // seconds
  audio: string; // mp3 URL (preview / play)
  audiodownload: string; // mp3 URL (higher quality where available)
  audiodownload_allowed: boolean;
  shareurl: string;
  image: string;
}

interface JamendoTracksResponse {
  headers: { status: string; code: number; error_message?: string };
  results: JamendoTrack[];
}

export async function searchJamendoTracks(
  clientId: string,
  query: string,
  page = 1,
  pageSize = 20,
): Promise<{ tracks: JamendoTrack[]; nextPage: number | null }> {
  const offset = (page - 1) * pageSize;
  const params = new URLSearchParams({
    client_id: clientId,
    format: "json",
    limit: String(pageSize),
    offset: String(offset),
    search: query,
    include: "musicinfo",
  });
  const res = await fetch(`${JAMENDO_API}/tracks/?${params}`);
  if (!res.ok) {
    throw new Error(`Jamendo search failed (${res.status})`);
  }
  const data = (await res.json()) as JamendoTracksResponse;
  if (data.headers?.code && data.headers.code !== 0) {
    throw new Error(`Jamendo error: ${data.headers.error_message || data.headers.status}`);
  }
  return {
    tracks: data.results,
    // Jamendo doesn't return a cursor; we assume next page exists iff we got a full page.
    nextPage: data.results.length === pageSize ? page + 1 : null,
  };
}

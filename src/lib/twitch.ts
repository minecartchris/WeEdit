// Thin Twitch Helix + ID API client. Auth is OAuth Device Code Flow — the only
// flow that doesn't need a redirect URL or a client secret, so it's the cleanest
// fit for a desktop app where we just want the user signed in to their own
// account once.
//
// All requests go through plain fetch — Twitch's APIs send permissive CORS
// headers, so the webview can hit them directly without a Rust proxy.

const TWITCH_DEVICE_URL = "https://id.twitch.tv/oauth2/device";
const TWITCH_TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_API_BASE = "https://api.twitch.tv/helix";

// Scopes we actually need. user:read:email gives us /users; channel:read:vods
// isn't a thing — videos are public-ish via /videos with user_id. We add
// user:read:broadcast just in case (subscriber-only VOD listing).
const SCOPES = "user:read:email user:read:broadcast";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string[];
  token_type: string;
}

export interface TwitchUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
  email?: string;
}

export interface TwitchVideo {
  id: string;
  user_id: string;
  user_login: string;
  user_name: string;
  title: string;
  description: string;
  created_at: string;
  published_at: string;
  url: string;
  thumbnail_url: string;
  view_count: number;
  language: string;
  type: "archive" | "highlight" | "upload";
  duration: string; // e.g. "3h2m1s"
}

// ── Device Code Flow ──

export async function requestDeviceCode(clientId: string): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: clientId, scopes: SCOPES });
  const res = await fetch(TWITCH_DEVICE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`Twitch device code request failed (${res.status}): ${await res.text()}`);
  return res.json();
}

/**
 * Polls the token endpoint. Returns null while the user hasn't authorized yet
 * (Twitch responds with HTTP 400 and `authorization_pending` for this state).
 * Throws on real errors (expired, denied, etc.).
 */
export async function pollDeviceToken(
  clientId: string,
  deviceCode: string,
): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    client_id: clientId,
    device_code: deviceCode,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (res.ok) return res.json();

  // Twitch returns 400 with a `message` for pending / slow_down / expired.
  let detail = "";
  try {
    const data = await res.json();
    detail = data?.message ?? "";
  } catch {
    /* ignore */
  }
  const lower = detail.toLowerCase();
  if (lower.includes("pending") || lower.includes("slow_down")) return null;
  throw new Error(`Twitch token error: ${detail || res.status}`);
}

/**
 * Exchanges a refresh_token for a new access_token. Twitch's public clients
 * (device-flow apps) don't need a client_secret — the client_id alone is
 * sufficient to refresh. The response includes a new refresh_token; store it.
 */
export async function refreshAccessToken(
  clientId: string,
  refreshToken: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  const res = await fetch(TWITCH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    let detail = "";
    try {
      const data = await res.json();
      detail = data?.message ?? "";
    } catch {
      /* ignore */
    }
    throw new Error(`Twitch refresh failed: ${detail || res.status}`);
  }
  return res.json();
}

// ── Helix endpoints ──

interface HelixResponse<T> {
  data: T[];
  pagination?: { cursor?: string };
}

async function helix<T>(
  path: string,
  clientId: string,
  accessToken: string,
  searchParams?: Record<string, string>,
): Promise<HelixResponse<T>> {
  const url = new URL(`${TWITCH_API_BASE}${path}`);
  if (searchParams) {
    for (const [k, v] of Object.entries(searchParams)) url.searchParams.set(k, v);
  }
  const res = await fetch(url.toString(), {
    headers: {
      "Client-ID": clientId,
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!res.ok) throw new Error(`Twitch ${path} failed (${res.status}): ${await res.text()}`);
  return res.json();
}

export async function getCurrentUser(clientId: string, accessToken: string): Promise<TwitchUser> {
  const r = await helix<TwitchUser>("/users", clientId, accessToken);
  if (!r.data?.[0]) throw new Error("Twitch /users returned no data");
  return r.data[0];
}

export async function listUserVideos(
  clientId: string,
  accessToken: string,
  userId: string,
  cursor?: string,
): Promise<{ videos: TwitchVideo[]; cursor?: string }> {
  const params: Record<string, string> = {
    user_id: userId,
    type: "archive",
    first: "20",
    sort: "time",
  };
  if (cursor) params.after = cursor;
  const r = await helix<TwitchVideo>("/videos", clientId, accessToken, params);
  return { videos: r.data, cursor: r.pagination?.cursor };
}

// ── Helpers ──

/** Replace %{width}x%{height} placeholders in the thumbnail URL. */
export function thumbnailUrl(template: string, width = 320, height = 180): string {
  return template
    .replace("%{width}", String(width))
    .replace("%{height}", String(height))
    .replace("%25%7Bwidth%7D", String(width))
    .replace("%25%7Bheight%7D", String(height));
}

/** Convert "3h2m1s" → "3:02:01"; missing parts default to 0. */
export function prettyDuration(duration: string): string {
  const re = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
  const m = duration.match(re);
  if (!m) return duration;
  const h = parseInt(m[1] ?? "0", 10);
  const min = parseInt(m[2] ?? "0", 10);
  const s = parseInt(m[3] ?? "0", 10);
  const pad = (n: number) => n.toString().padStart(2, "0");
  return h > 0 ? `${h}:${pad(min)}:${pad(s)}` : `${min}:${pad(s)}`;
}

/** yt-dlp command line a user can paste into a terminal to download a VOD. */
export function ytDlpCommand(videoUrl: string, outputDir?: string): string {
  const out = outputDir
    ? ` -o "${outputDir.replace(/[/\\]+$/, "")}\\%(title)s [%(id)s].%(ext)s"`
    : "";
  return `yt-dlp${out} "${videoUrl}"`;
}

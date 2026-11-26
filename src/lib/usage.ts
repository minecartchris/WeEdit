import { COLLAB_API } from "@/lib/collab/config";
import { isTauri } from "@/lib/platform";
import { usePrefs } from "@/state/prefs";

// The anonymous "this install is in use" ping behind the website's user count.
//
// What's sent, at most once a day: a random ID made up on first launch (not
// derived from the machine or the user), the app version, and the OS family.
// Nothing about projects, files, names or accounts. Users can switch it off in
// Settings → Privacy (`shareUsageStats`), and it's never sent while that's off.
//
// The endpoint lives on the collaboration server (same host as signaling), so
// there's no extra service to run.

const ID_KEY = "weedit.usage.id";
const LAST_KEY = "weedit.usage.lastPing";
const DAY_MS = 24 * 60 * 60 * 1000;

/** https:// origin of the collab server, derived from the signaling wss:// URL. */
export const USAGE_API = COLLAB_API;

function installId(): string {
  let id = localStorage.getItem(ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(ID_KEY, id);
  }
  return id;
}

function osFamily(): string {
  if (!isTauri()) return "web";
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other";
}

async function appVersion(): Promise<string> {
  if (!isTauri()) return "web";
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return "";
  }
}

/** Send today's ping if allowed and not already sent today. Never throws. */
export async function maybeSendUsagePing(): Promise<void> {
  try {
    if (!usePrefs.getState().shareUsageStats) return;
    const last = Number(localStorage.getItem(LAST_KEY) || 0);
    if (Date.now() - last < DAY_MS) return;
    const res = await fetch(`${USAGE_API}/ping`, {
      method: "POST",
      // text/plain keeps this a "simple" request — no CORS preflight round trip.
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ id: installId(), version: await appVersion(), os: osFamily() }),
    });
    if (res.ok) localStorage.setItem(LAST_KEY, String(Date.now()));
  } catch {
    // Offline / server down: try again next launch.
  }
}

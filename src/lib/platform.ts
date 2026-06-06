// Platform detection — is the editor running inside the Tauri desktop shell, or
// as the browser "web copy" served from the website?
//
// We ship the same React UI in two places:
//   - The desktop app (Tauri) — full native power: ffmpeg, yt-dlp, NAS, local
//     file save. This is the recommended experience and where performance lives.
//   - A web copy hosted at /editor on the marketing site — same UI so people can
//     try it instantly, but native-only features are unavailable in a browser.
//
// Tauri v2 injects `window.__TAURI_INTERNALS__` into the webview before any app
// code runs. Its absence means we're a plain browser tab. Detection is a cheap
// synchronous property check — safe to call anywhere, including at module load.

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

/** True when running inside the Tauri desktop shell (native APIs available). */
export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null;
}

/** True for the browser-hosted web copy of the editor (no native APIs). */
export function isWeb(): boolean {
  return !isTauri();
}

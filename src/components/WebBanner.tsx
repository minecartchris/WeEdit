import { useEffect, useState } from "react";
import { Download, Monitor, X } from "lucide-react";
import { isWeb } from "@/lib/platform";
import { LATEST_RELEASE_API, LATEST_RELEASE_URL } from "@/lib/links";

// Web-only strip shown above the editor when it's running as the browser copy
// (served from /editor on the marketing site). It makes two things obvious:
//   1. This is a try-it-in-your-browser preview — native features (export,
//      Twitch/yt-dlp download, NAS, saving to disk) live in the desktop app.
//   2. Where to get the desktop app, deep-linked to the newest release.
// On the desktop build isWeb() is false and this renders nothing.

interface LatestRelease {
  tag_name?: string;
  assets?: { name: string; browser_download_url: string }[];
}

type Platform = { label: string; url: string };

/** Pick the best installer asset for the visitor's OS (Win .exe, Linux AppImage). */
function pickInstaller(release: LatestRelease): Platform | null {
  const assets = (release.assets ?? []).filter((a) => !/\.(sig|json)$/i.test(a.name));
  const find = (re: RegExp) => assets.find((a) => re.test(a.name)) ?? null;
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

  if (/Linux|X11/i.test(ua) && !/Android/i.test(ua)) {
    const appimage = find(/\.appimage$/i);
    if (appimage) return { label: "Download for Linux", url: appimage.browser_download_url };
    const deb = find(/\.deb$/i);
    if (deb) return { label: "Download .deb", url: deb.browser_download_url };
  }
  const win = find(/\.exe$/i) ?? find(/\.msi$/i);
  if (win) return { label: "Download for Windows", url: win.browser_download_url };
  return null;
}

export function WebBanner() {
  const [dismissed, setDismissed] = useState(false);
  const [version, setVersion] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState(LATEST_RELEASE_URL);
  const [downloadLabel, setDownloadLabel] = useState("Download desktop app");

  useEffect(() => {
    if (!isWeb()) return;
    let cancelled = false;
    // Best-effort: surface the latest version + a direct installer link for the
    // visitor's OS. If the GitHub API is unreachable (rate limit, offline), we
    // keep the generic "latest release" link, which always resolves to the
    // newest build for any platform.
    fetch(LATEST_RELEASE_API, { headers: { Accept: "application/vnd.github+json" } })
      .then((r) => (r.ok ? (r.json() as Promise<LatestRelease>) : null))
      .then((release) => {
        if (cancelled || !release) return;
        if (release.tag_name) setVersion(release.tag_name);
        const direct = pickInstaller(release);
        if (direct) {
          setDownloadUrl(direct.url);
          setDownloadLabel(direct.label);
        }
      })
      .catch(() => {
        /* keep the fallback link */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isWeb() || dismissed) return null;

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-1.5 bg-we-teal text-white text-sm">
      <Monitor size={16} className="shrink-0 opacity-90" />
      <span className="min-w-0 truncate">
        You're using the <strong>web preview</strong> of WeEdit. Export, VOD
        download, NAS and saving to disk need the desktop app.
      </span>
      <a
        href={downloadUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="ml-auto shrink-0 inline-flex items-center gap-1.5 rounded bg-white/15 hover:bg-white/25 px-2.5 py-1 font-medium transition-colors"
      >
        <Download size={15} />
        {downloadLabel}{version ? ` (${version})` : ""}
      </a>
      <button
        onClick={() => setDismissed(true)}
        className="shrink-0 rounded p-1 hover:bg-white/20 transition-colors"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={15} />
      </button>
    </div>
  );
}

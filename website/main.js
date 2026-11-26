// Landing-page enhancement: resolve the newest GitHub release once, then point
// each platform's download at its direct installer (Windows .exe, Linux
// .AppImage, Linux .deb) and label the hero button for the visitor's own OS.
//
// If GitHub is unreachable (offline / rate-limited), every button keeps its
// hard-coded fallback href (the /releases/latest redirect), so downloads always
// work — this script only upgrades them to one-click direct links.

const OWNER = "minecartchris";
const REPO = "WeEdit";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;
const RELEASES_API = `https://api.github.com/repos/${OWNER}/${REPO}/releases?per_page=100`;
// Usage counter (served by the collaboration server). Same-origin through the
// site's nginx first; the server's own port as a fallback.
const STATS_URLS = ["/api/stats", "https://weedit.minecartchris.cc:8443/api/stats"];

/** Sort release assets into the platforms we publish. */
function categorize(assets) {
  const usable = (assets || []).filter((a) => !/\.(sig|json)$/i.test(a.name));
  const find = (re) => usable.find((a) => re.test(a.name)) || null;
  return {
    windows: find(/\.exe$/i) || find(/\.msi$/i),
    appimage: find(/\.appimage$/i),
    deb: find(/\.deb$/i),
  };
}

/** Best guess at the visitor's OS from the UA string. */
function detectOS() {
  const ua = navigator.userAgent || "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Android/i.test(ua)) return "other"; // no Android build
  if (/Linux|X11/i.test(ua)) return "linux";
  return "other"; // mac / unknown — no build, send them to the full list
}

function setHref(id, url) {
  const el = document.getElementById(id);
  if (el && url) el.href = url;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el && text) el.textContent = text;
}

async function init() {
  let release;
  try {
    const res = await fetch(API, { headers: { Accept: "application/vnd.github+json" } });
    if (!res.ok) return;
    release = await res.json();
  } catch {
    return; // keep fallback hrefs
  }

  const version = release.tag_name || "";
  const assets = categorize(release.assets);

  // Per-platform download cards (in the #downloads section).
  if (assets.windows) setHref("dl-windows", assets.windows.browser_download_url);
  if (assets.appimage) setHref("dl-appimage", assets.appimage.browser_download_url);
  if (assets.deb) setHref("dl-deb", assets.deb.browser_download_url);

  // Show the file size on each card's sub-label when we know it.
  const mb = (a) => (a && a.size ? ` · ${(a.size / 1048576).toFixed(0)} MB` : "");
  if (assets.windows) setText("dl-windows-kind", "Installer (.exe)" + mb(assets.windows));
  if (assets.appimage) setText("dl-appimage-kind", "AppImage (portable)" + mb(assets.appimage));
  if (assets.deb) setText("dl-deb-kind", "Package (.deb)" + mb(assets.deb));

  // Hero button: point at the visitor's own platform, label accordingly. Linux
  // gets the AppImage (runs on any distro, no install). Anything we don't build
  // for falls through to the downloads section.
  const os = detectOS();
  const heroBtn = document.getElementById("hero-download");
  if (os === "windows" && assets.windows) {
    setHref("hero-download", assets.windows.browser_download_url);
    setText("hero-download-label", `Download for Windows${version ? ` · ${version}` : ""}`);
  } else if (os === "linux" && (assets.appimage || assets.deb)) {
    const pick = assets.appimage || assets.deb;
    setHref("hero-download", pick.browser_download_url);
    const kind = assets.appimage ? "Linux (.AppImage)" : "Linux (.deb)";
    setText("hero-download-label", `Download for ${kind}${version ? ` · ${version}` : ""}`);
  } else if (heroBtn) {
    // mac / unknown: link to the platform list instead of a wrong installer.
    heroBtn.href = "#downloads";
    setText("hero-download-label", "Download WeEdit");
  }

  // Version + date line under the downloads heading.
  if (version) {
    const when = release.published_at
      ? new Date(release.published_at).toLocaleDateString(undefined, {
          year: "numeric",
          month: "short",
          day: "numeric",
        })
      : null;
    setText(
      "downloads-version",
      `Latest release ${version}` + (when ? ` · ${when}` : "") + " · Windows 10/11 & Linux (x86-64)",
    );
    setText(
      "hero-version",
      `Latest release ${version} · Windows & Linux`,
    );
    // Re-add the "all downloads" anchor that setText would have wiped.
    const sub = document.getElementById("hero-version");
    if (sub) {
      sub.insertAdjacentHTML("beforeend", ' · <a href="#downloads">all downloads</a>');
    }
  }
}

/** Total downloads of the installers across every release (not .sig / .json). */
async function totalDownloads() {
  let total = 0;
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${RELEASES_API}&page=${page}`, {
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!res.ok) break;
    const releases = await res.json();
    for (const r of releases) {
      for (const a of r.assets || []) {
        if (/\.(exe|msi|deb|appimage|rpm)$/i.test(a.name)) total += a.download_count || 0;
      }
    }
    if (releases.length < 100) break;
  }
  return total;
}

async function usageStats() {
  for (const url of STATS_URLS) {
    try {
      const res = await fetch(url, { cache: "no-store" });
      if (res.ok) return await res.json();
    } catch {
      // try the next one
    }
  }
  return null;
}

const fmt = (n) => (typeof n === "number" ? n.toLocaleString() : "–");

async function initStats() {
  const [downloads, usage] = await Promise.all([
    totalDownloads().catch(() => null),
    usageStats(),
  ]);
  if (downloads == null && usage == null) return; // nothing to show — keep it hidden
  setText("stat-downloads", fmt(downloads));
  setText("stat-users", fmt(usage && usage.users));
  setText("stat-active", fmt(usage && usage.active30d));
  const box = document.getElementById("usage-stats");
  if (box) box.hidden = false;
}

init();
initStats();

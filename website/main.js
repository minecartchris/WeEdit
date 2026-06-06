// Landing-page enhancement: resolve the newest GitHub release once and point
// every "Download" button at the direct Windows installer, with the version
// shown. If GitHub is unreachable (offline / rate-limited), the buttons keep
// their hard-coded fallback href (the /releases/latest redirect), so downloads
// always work — this script only upgrades them to a one-click direct link.

const OWNER = "minecartchris";
const REPO = "WeEdit";
const API = `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`;

/** Pick the Windows installer asset: NSIS .exe preferred, else .msi. */
function installerAsset(assets) {
  const usable = (assets || []).filter((a) => !/\.(sig|json)$/i.test(a.name));
  return (
    usable.find((a) => /\.exe$/i.test(a.name)) ||
    usable.find((a) => /\.msi$/i.test(a.name)) ||
    null
  );
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
  const asset = installerAsset(release.assets);
  const directUrl = asset ? asset.browser_download_url : null;

  // Point all download buttons at the direct installer when we have one.
  if (directUrl) {
    for (const id of ["nav-download", "hero-download", "compare-download", "final-download"]) {
      const el = document.getElementById(id);
      if (el) el.href = directUrl;
    }
  }

  // Surface the version on the hero button + subline.
  if (version) {
    const label = document.getElementById("hero-download-label");
    if (label) label.textContent = `Download for Windows · ${version}`;

    const sub = document.getElementById("hero-version");
    if (sub) {
      const when = release.published_at
        ? new Date(release.published_at).toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          })
        : null;
      sub.textContent = `Latest release ${version}` + (when ? ` · ${when}` : "") + " · Windows 10/11";
    }
  }
}

init();

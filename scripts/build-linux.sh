#!/usr/bin/env bash
# Build a Linux WeEdit bundle (.deb + .AppImage) from a copy of the working tree.
#
# Invoked by `python scripts/release.py build-linux` inside WSL (Ubuntu). Tauri
# can't cross-compile Windows->Linux, so this runs natively on Linux against an
# rsync'd copy of the repo placed in the Linux filesystem -- that keeps the
# Windows node_modules (win32-native esbuild/rollup/tauri-cli) untouched.
#
# ffmpeg is NOT bundled in the Linux package; the app falls back to ffmpeg on
# PATH at runtime, so we make sure system ffmpeg is installed here too.
#
# Required env: SRC_DIR (repo, mounted), VERSION (e.g. 0.0.58), OUT_DIR (where
# artifacts are copied). Optional: BUILD_DIR (default ~/weedit-linux-build),
# AUTO_INSTALL=1 to apt/rustup-install missing deps (0 = just print commands).
set -euo pipefail

: "${SRC_DIR:?SRC_DIR not set}"
: "${VERSION:?VERSION not set}"
: "${OUT_DIR:?OUT_DIR not set}"
BUILD_DIR="${BUILD_DIR:-$HOME/weedit-linux-build}"
AUTO_INSTALL="${AUTO_INSTALL:-1}"

# This runs as a non-login shell, so make sure toolchain bin dirs are reachable.
export PATH="$HOME/.cargo/bin:$HOME/.local/bin:$PATH"

# Default WSL user is often root, where `sudo` may be absent and unneeded.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi

log() { printf '\033[36m==> %s\033[0m\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- 1. system build deps (Tauri's Linux prerequisites + ffmpeg) ----------
APT_PKGS=(build-essential curl wget file rsync libssl-dev librsvg2-dev \
  libgtk-3-dev libxdo-dev libayatana-appindicator3-dev ffmpeg)
# The webkit dev package was renamed 4.0 -> 4.1; pick whichever this release has.
if apt-cache show libwebkit2gtk-4.1-dev >/dev/null 2>&1; then
  APT_PKGS+=(libwebkit2gtk-4.1-dev)
else
  APT_PKGS+=(libwebkit2gtk-4.0-dev)
fi

missing=()
for p in "${APT_PKGS[@]}"; do
  dpkg -s "$p" >/dev/null 2>&1 || missing+=("$p")
done
if [ "${#missing[@]}" -gt 0 ]; then
  log "Missing system packages: ${missing[*]}"
  if [ "$AUTO_INSTALL" = "1" ]; then
    $SUDO apt-get update
    $SUDO apt-get install -y "${missing[@]}"
  else
    echo "Install them with:  sudo apt-get install -y ${missing[*]}"
    exit 1
  fi
else
  # Even when present, make sure ffmpeg is up to date (user asked to upgrade it).
  [ "$AUTO_INSTALL" = "1" ] && $SUDO apt-get install -y --only-upgrade ffmpeg || true
fi

# --- 2. Rust + Node toolchains --------------------------------------------
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"
if ! have cargo; then
  if [ "$AUTO_INSTALL" = "1" ]; then
    log "Installing Rust via rustup"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
    . "$HOME/.cargo/env"
  else
    echo "Install Rust from https://rustup.rs and re-run."
    exit 1
  fi
fi

if ! have node; then
  if [ "$AUTO_INSTALL" = "1" ]; then
    log "Installing Node.js + npm via apt"
    $SUDO apt-get install -y nodejs npm
  else
    echo "Install Node.js 18+ and re-run."
    exit 1
  fi
fi
log "Toolchains: node $(node -v), npm $(npm -v), $(cargo --version)"

# --- 3. sync the working tree into a Linux-native build dir ---------------
# Exclude platform-specific / heavy dirs so npm install rebuilds Linux deps and
# we don't drag a 150 MB Windows ffmpeg.exe into the copy.
log "Syncing working tree -> $BUILD_DIR"
mkdir -p "$BUILD_DIR"
rsync -a --delete \
  --exclude '.git' \
  --exclude 'node_modules' \
  --exclude 'dist' --exclude 'dist-web' --exclude 'dist-linux' \
  --exclude 'src-tauri/target' \
  --exclude 'src-tauri/binaries' \
  "$SRC_DIR/" "$BUILD_DIR/"
cd "$BUILD_DIR"

# --- 4. patch the config for a Linux build --------------------------------
# Inject the release version and drop the Windows-only bundled-ffmpeg resources
# (resources hardcode binaries/ffmpeg.exe; on Linux we rely on system ffmpeg).
# This copy is disposable, so edit it in place -- no backup/restore needed.
node -e '
  const fs = require("fs");
  const f = "src-tauri/tauri.conf.json";
  const c = JSON.parse(fs.readFileSync(f, "utf8"));
  c.version = process.env.VERSION;
  c.bundle = c.bundle || {};
  c.bundle.resources = {};
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
'
mkdir -p src-tauri/binaries

# --- 5. build -------------------------------------------------------------
log "npm install (Linux-native deps)"
npm install
log "Building Linux bundle $VERSION (.deb + .AppImage) -- this takes a while"
# linuxdeploy (which Tauri uses to assemble the AppImage) is itself an AppImage
# and tries to FUSE-mount to run. WSL/containers usually have no FUSE, so it
# dies with "failed to run linuxdeploy". Extract-and-run skips the mount and the
# FUSE requirement entirely. ARCH is what the AppImage tooling expects.
export APPIMAGE_EXTRACT_AND_RUN=1
export ARCH="${ARCH:-x86_64}"
# `tauri build` runs the configured beforeBuildCommand (npm run build) itself.
npx tauri build --bundles deb,appimage

# --- 6. collect artifacts back onto the Windows side ----------------------
mkdir -p "$OUT_DIR"
shopt -s nullglob
artifacts=(
  src-tauri/target/release/bundle/deb/*.deb
  src-tauri/target/release/bundle/appimage/*.AppImage
)
if [ "${#artifacts[@]}" -eq 0 ]; then
  echo "error: no .deb/.AppImage artifacts were produced" >&2
  exit 1
fi
for a in "${artifacts[@]}"; do cp -v "$a" "$OUT_DIR/"; done
log "Done. Linux artifacts copied to: $OUT_DIR"
ls -la "$OUT_DIR"

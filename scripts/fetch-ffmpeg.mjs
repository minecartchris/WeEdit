// Downloads ffmpeg + ffprobe (Windows essentials build from gyan.dev) into
// src-tauri/binaries/ so they get bundled with the installer.
//
// Run once before building a release:    npm run fetch-binaries
// CI runs this automatically via .github/workflows/release.yml.
//
// The binaries are intentionally NOT committed (see .gitignore). Each build
// machine fetches its own copy; ~110 MB download → ~150 MB extracted.

import { execSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const OUT_DIR = resolve("src-tauri/binaries");
const FFMPEG_URL = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
// Anything smaller than this is a 0-byte placeholder (we ship those so
// `cargo check` doesn't fail when bundled-resources are listed in tauri.conf).
const REAL_BINARY_MIN_BYTES = 1024 * 1024;

function isRealBinary(path) {
  try {
    return statSync(path).size > REAL_BINARY_MIN_BYTES;
  } catch {
    return false;
  }
}

function alreadyHave() {
  return (
    isRealBinary(join(OUT_DIR, "ffmpeg.exe")) &&
    isRealBinary(join(OUT_DIR, "ffprobe.exe"))
  );
}

function step(msg) {
  process.stdout.write(`▸ ${msg}\n`);
}

async function main() {
  if (alreadyHave()) {
    step(`ffmpeg + ffprobe already present in ${OUT_DIR} — skipping`);
    return;
  }

  mkdirSync(OUT_DIR, { recursive: true });

  const work = join(tmpdir(), `weedit-ffmpeg-${Date.now()}`);
  mkdirSync(work);
  const zip = join(work, "ffmpeg.zip");

  step(`downloading ${FFMPEG_URL}`);
  step("(this is ~110 MB, one-time per build environment)");
  execSync(`curl -L --fail -o "${zip}" "${FFMPEG_URL}"`, { stdio: "inherit" });

  step("extracting");
  execSync(`tar -xf "${zip}" -C "${work}"`, { stdio: "inherit" });

  const root = readdirSync(work).find(
    (n) => n.startsWith("ffmpeg-") && n.includes("essentials"),
  );
  if (!root) {
    throw new Error("Could not find extracted ffmpeg directory in the zip");
  }

  const bin = join(work, root, "bin");
  copyFileSync(join(bin, "ffmpeg.exe"), join(OUT_DIR, "ffmpeg.exe"));
  copyFileSync(join(bin, "ffprobe.exe"), join(OUT_DIR, "ffprobe.exe"));

  rmSync(work, { recursive: true, force: true });

  step(`✓ ffmpeg + ffprobe extracted to ${OUT_DIR}`);
}

main().catch((err) => {
  console.error("fetch-ffmpeg failed:", err.message ?? err);
  process.exit(1);
});

// Remove installer artifacts from previous builds before a new one runs, so the
// bundle folder doesn't accumulate every old version (WeEdit_0.0.11…, 0.0.12…,
// and so on). Wired into the `tauri:build` / `tauri:build:release` npm scripts,
// it runs just before `tauri build`, which then regenerates only the version it
// is currently building.
//
// Safe + idempotent: only touches the Windows installer output dirs under
// target/release/bundle, and no-ops when they don't exist yet.

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const bundleDir = join(repoRoot, "src-tauri", "target", "release", "bundle");

// The per-format installer dirs Tauri writes on Windows, plus the loose
// latest.json the release flow drops at the bundle root.
const installerDirs = ["msi", "nsis"];
const looseFiles = ["latest.json"];

let removed = 0;

function rm(path) {
  try {
    rmSync(path, { recursive: true, force: true });
    removed += 1;
  } catch (err) {
    console.warn(`  ! could not remove ${path}: ${err.message}`);
  }
}

if (!existsSync(bundleDir)) {
  console.log("clean-installers: no bundle dir yet — nothing to clean.");
  process.exit(0);
}

for (const sub of installerDirs) {
  const dir = join(bundleDir, sub);
  if (!existsSync(dir)) continue;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    // Wipe installer payloads + their signatures (.msi/.exe/.sig); leave any
    // unexpected subdirectory alone.
    if (statSync(full).isFile()) rm(full);
  }
}

for (const name of looseFiles) {
  const full = join(bundleDir, name);
  if (existsSync(full)) rm(full);
}

console.log(
  removed > 0
    ? `clean-installers: removed ${removed} old installer artifact${removed === 1 ? "" : "s"}.`
    : "clean-installers: nothing to clean.",
);

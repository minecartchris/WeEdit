import { basename, importPath, pickReplacementFile } from "@/lib/media";
import { invalidateWaveform } from "@/lib/waveform";
import { useEditor } from "@/state/editor";
import { checkMissingMedia, useMissingMedia } from "@/state/missingMedia";
import type { MediaItem } from "@/types";

function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

function joinPath(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return `${dir}${sep}${name}`;
}

async function relinkTo(item: MediaItem, newPath: string): Promise<boolean> {
  const next = await importPath(newPath, item.id);
  if (!next) return false;
  invalidateWaveform(item.id);
  useEditor.getState().relinkMedia(item.id, next);
  return true;
}

/**
 * "Replace file…" for a media item whose file moved: pick the file's new
 * location and point the item (and every timeline clip using it) there.
 * Afterwards, any other missing media that lived in the same old folder is
 * looked up by filename in the new folder and relinked too, since files are
 * usually moved together.
 *
 * Returns an error message to show, or null on success / cancel.
 */
export async function replaceMediaFile(item: MediaItem): Promise<string | null> {
  const picked = await pickReplacementFile(item);
  if (!picked) return null;

  let next: MediaItem | null;
  try {
    next = await importPath(picked, item.id);
  } catch (err) {
    console.warn("Replace file: import failed", err);
    return `Couldn't open ${basename(picked)}`;
  }
  if (!next) return `${basename(picked)} isn't a supported media file`;
  if (next.kind !== item.kind) return `${basename(picked)} is a ${next.kind}, not a ${item.kind}`;

  // Same check Resolve does before swapping: warn when the picked file doesn't
  // look like the original (different name or noticeably different length),
  // since the timeline's trims are positions in the original's source time.
  const warnings: string[] = [];
  if (next.name !== item.name) warnings.push(`its name differs ("${next.name}" vs "${item.name}")`);
  if (
    item.durationSec != null &&
    next.durationSec != null &&
    Math.abs(item.durationSec - next.durationSec) > 0.5
  ) {
    warnings.push("its length differs from the original");
  }
  if (
    warnings.length > 0 &&
    !window.confirm(`The selected file may not be the same media: ${warnings.join(" and ")}.\n\nReplace anyway?`)
  ) {
    return null;
  }

  const oldDir = dirname(item.src);
  const newDir = dirname(picked);
  invalidateWaveform(item.id);
  useEditor.getState().relinkMedia(item.id, next);

  // Batch-relink siblings that were moved along with it.
  if (oldDir && newDir && oldDir !== newDir) {
    const { invoke } = await import("@tauri-apps/api/core");
    const missing = new Set(useMissingMedia.getState().missingIds);
    for (const m of useEditor.getState().media) {
      if (m.id === item.id || !missing.has(m.id) || dirname(m.src) !== oldDir) continue;
      const candidate = joinPath(newDir, basename(m.src));
      try {
        if (await invoke<boolean>("path_exists", { path: candidate })) await relinkTo(m, candidate);
      } catch (err) {
        console.warn("Replace file: auto-relink failed for", m.name, err);
      }
    }
  }

  await checkMissingMedia();
  return null;
}

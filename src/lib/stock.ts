import { invoke } from "@tauri-apps/api/core";
import { documentDir, join } from "@tauri-apps/api/path";
import { importPath } from "@/lib/media";
import { useEditor } from "@/state/editor";
import type { DragSource } from "@/lib/customDrag";
import type { MediaItem, MediaKind } from "@/types";

// Helpers for "stock" assets — items the user discovers in the Stock browser
// (Pexels for now) and either drops onto the timeline or clicks to add to the
// library. Both flows route through the same import-on-resolve pattern so
// downloads only happen when the user commits to using the asset.

const SUBFOLDER = "stock";

async function defaultStockDir(): Promise<string> {
  const projectPath = useEditor.getState().projectPath;
  if (projectPath) return `${projectPath}/${SUBFOLDER}`;
  const docs = await documentDir();
  return join(docs, "WeEdit Downloads", SUBFOLDER);
}

function safeFilename(s: string, fallback: string): string {
  const cleaned = s
    .normalize("NFKD")
    .replace(/[^\w\s.-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 80);
  return cleaned || fallback;
}

/**
 * Downloads `url` into the stock folder (project-aware) and imports the
 * resulting file as a MediaItem. Returns the imported item, or null on failure.
 */
export async function downloadStockAsset(args: {
  url: string;
  suggestedName: string;
  ext: string;
  kind: MediaKind;
}): Promise<MediaItem | null> {
  const dir = await defaultStockDir();
  const filename = `${safeFilename(args.suggestedName, "stock")}.${args.ext.replace(/^\./, "")}`;
  const outPath = `${dir}/${filename}`;

  await invoke<string>("http_download", { url: args.url, outputPath: outPath });

  const item = await importPath(outPath);
  if (item) useEditor.getState().addMedia(item);
  return item;
}

/** Builds a DragSource for a stock asset — `resolve()` triggers the download. */
export function stockDragSource(args: {
  kind: MediaKind;
  label: string;
  url: string;
  suggestedName: string;
  ext: string;
}): DragSource {
  return {
    kind: args.kind,
    label: args.label,
    resolve: () =>
      downloadStockAsset({
        url: args.url,
        suggestedName: args.suggestedName,
        ext: args.ext,
        kind: args.kind,
      }),
  };
}

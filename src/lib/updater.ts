import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

// Thin wrapper around tauri-plugin-updater. The plugin handles HTTPS to the
// GitHub Releases endpoint, signature verification, download, and install.
// We just surface state into the React UI.

export type CheckResult =
  | { status: "up-to-date" }
  | {
      status: "available";
      version: string;
      currentVersion: string;
      notes?: string;
      install: (onProgress?: (bytes: number, total?: number) => void) => Promise<void>;
    }
  | { status: "error"; error: string };

export async function checkForUpdate(): Promise<CheckResult> {
  let update: Update | null = null;
  try {
    update = await check();
  } catch (err) {
    return { status: "error", error: err instanceof Error ? err.message : String(err) };
  }
  if (!update) return { status: "up-to-date" };

  return {
    status: "available",
    version: update.version,
    currentVersion: update.currentVersion,
    notes: update.body,
    install: async (onProgress) => {
      let downloaded = 0;
      let total: number | undefined;
      await update.downloadAndInstall((evt) => {
        if (evt.event === "Started") {
          total = evt.data.contentLength ?? undefined;
        } else if (evt.event === "Progress") {
          downloaded += evt.data.chunkLength;
          onProgress?.(downloaded, total);
        }
      });
      // Windows installer relaunches the app for us; on other platforms we
      // ask the OS to restart so the new binary takes effect.
      try {
        await relaunch();
      } catch (err) {
        console.warn("relaunch failed (installer may handle it):", err);
      }
    },
  };
}

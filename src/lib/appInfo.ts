import { useEffect, useState } from "react";
import { GITHUB_OWNER, GITHUB_REPO } from "@/lib/links";
import { isTauri } from "@/lib/platform";

// The running app's version and the release notes behind the "What's new" menu.
// The Help menu used to print a hard-coded "v0.0.1" no matter the build.

let versionPromise: Promise<string> | null = null;

export function appVersion(): Promise<string> {
  versionPromise ??= (async () => {
    if (!isTauri()) return "web";
    try {
      const { getVersion } = await import("@tauri-apps/api/app");
      return await getVersion();
    } catch {
      return "";
    }
  })();
  return versionPromise;
}

export function useAppVersion(): string {
  const [v, setV] = useState("");
  useEffect(() => {
    void appVersion().then(setV);
  }, []);
  return v;
}

export interface ReleaseNote {
  version: string;
  title: string;
  body: string;
  url: string;
  publishedAt: string | null;
}

const RELEASES_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=5`;
let notesPromise: Promise<ReleaseNote[]> | null = null;

/** The newest few releases' notes (cached for the session; empty when offline). */
export function releaseNotes(): Promise<ReleaseNote[]> {
  notesPromise ??= (async () => {
    try {
      const res = await fetch(RELEASES_API, { headers: { Accept: "application/vnd.github+json" } });
      if (!res.ok) return [];
      const releases = (await res.json()) as Array<{
        tag_name: string;
        name: string | null;
        body: string | null;
        html_url: string;
        published_at: string | null;
      }>;
      return releases.map((r) => ({
        version: (r.name ?? r.tag_name).replace(/^WeEdit\s+/, ""),
        title: r.name ?? r.tag_name,
        body: (r.body ?? "").trim(),
        url: r.html_url,
        publishedAt: r.published_at,
      }));
    } catch {
      return [];
    }
  })();
  return notesPromise;
}

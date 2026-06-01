import { invoke } from "@tauri-apps/api/core";
import type { NasConnection } from "@/lib/config";

export interface DirEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes?: number;
  modified?: number;
}

interface RawDirEntry {
  name: string;
  path: string;
  is_directory: boolean;
  size_bytes?: number;
  modified?: number;
}

export function uncRoot(conn: NasConnection): string {
  return `\\\\${conn.host}\\${conn.share}`;
}

/** Mounts the share with the given creds via `net use` (no-op if no creds). */
export async function authenticate(conn: NasConnection): Promise<void> {
  await invoke("smb_authenticate", {
    target: uncRoot(conn),
    username: conn.username ?? null,
    password: conn.password ?? null,
  });
}

export async function listShare(conn: NasConnection, subpath = ""): Promise<DirEntry[]> {
  const root = uncRoot(conn);
  const path = subpath
    ? `${root}\\${subpath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "").replace(/\//g, "\\")}`
    : root;
  const raw = await invoke<RawDirEntry[]>("list_directory", { path });
  return raw.map((r) => ({
    name: r.name,
    path: r.path,
    isDirectory: r.is_directory,
    sizeBytes: r.size_bytes,
    modified: r.modified,
  }));
}

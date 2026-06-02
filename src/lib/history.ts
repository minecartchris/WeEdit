import { invoke } from "@tauri-apps/api/core";
import type { ProjectFileV1 } from "@/lib/project";

// Git-like version history for a .weedit project.
//
// On-disk layout (lives alongside project.json):
//   <name>.weedit/
//     history/
//       log.json                 ← { version, head, commits: Commit[] }  (the DAG)
//       snapshots/<hash>.json     ← a full ProjectFileV1, content-addressed by sha256
//
// Why full snapshots instead of diffs: a project.json is kilobytes (no media
// binaries live in it), so storing one snapshot per commit is tiny, dedupes by
// content hash, and is bulletproof for "go back in time without losing data".
//
// Lossless time-travel: restoring a commit moves `head` but NEVER deletes
// commits. Editing after a restore appends a new commit whose parent is the
// restored one — branching the DAG. Nothing is ever discarded.
//
// All IO reuses the existing Rust fs commands (read_project_file /
// write_project_file / path_exists). write_project_file creates parent dirs, so
// no explicit ensure_dir is needed for snapshot writes.

export interface Commit {
  /** Stable unique id (uuid). */
  id: string;
  /** Previous commit on this line of history; null for the first commit. */
  parent: string | null;
  message: string;
  kind: "manual" | "auto";
  /** Collaborator display name, when known (Phase 2). Undefined when solo. */
  author?: string;
  createdAt: number;
  /** Points at history/snapshots/<snapshotHash>.json. */
  snapshotHash: string;
}

export interface HistoryFile {
  version: 1;
  /** Id of the commit the working state currently sits on. */
  head: string | null;
  /** All commits, oldest-first. The DAG is reconstructed from parent pointers. */
  commits: Commit[];
}

const HISTORY_DIR = "history";
const LOG_FILE = "log.json";

function historyDir(folder: string): string {
  return `${folder}/${HISTORY_DIR}`;
}

function logPath(folder: string): string {
  return `${historyDir(folder)}/${LOG_FILE}`;
}

function snapshotPath(folder: string, hash: string): string {
  return `${historyDir(folder)}/snapshots/${hash}.json`;
}

function emptyHistory(): HistoryFile {
  return { version: 1, head: null, commits: [] };
}

/** SHA-256 of a string, hex-encoded — via Web Crypto (no native dependency). */
export async function sha256(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Read / write ─────────────────────────────────────────────────────────────

export async function loadHistory(folder: string): Promise<HistoryFile> {
  try {
    const text = await invoke<string>("read_project_file", { path: logPath(folder) });
    const data = JSON.parse(text) as HistoryFile;
    if (data.version !== 1 || !Array.isArray(data.commits)) return emptyHistory();
    return data;
  } catch {
    // No history yet — first time versioning this project.
    return emptyHistory();
  }
}

async function writeHistory(folder: string, history: HistoryFile): Promise<void> {
  await invoke("write_project_file", {
    path: logPath(folder),
    content: JSON.stringify(history, null, 2),
  });
}

/** List commits newest-first for display. */
export async function listCommits(folder: string): Promise<{ head: string | null; commits: Commit[] }> {
  const history = await loadHistory(folder);
  return { head: history.head, commits: [...history.commits].reverse() };
}

/**
 * Record a new version. The snapshot is hashed and written content-addressed
 * (skipped if an identical snapshot already exists). A commit pointing at it is
 * appended with `parent = current head`, and head advances to the new commit.
 * Returns the created commit, or the existing head commit if nothing changed
 * since the last version (no-op dedupe).
 */
export async function commitVersion(
  folder: string,
  file: ProjectFileV1,
  message: string,
  kind: Commit["kind"],
  author?: string,
): Promise<Commit> {
  const history = await loadHistory(folder);
  // Stable hash: strip the per-save timestamp so an unchanged project doesn't
  // create churn-only commits.
  const { savedAt: _savedAt, ...stable } = file;
  const content = JSON.stringify(stable, null, 2);
  const snapshotHash = await sha256(content);

  // No-op dedupe: if head already points at this exact snapshot, don't commit.
  const headCommit = history.commits.find((c) => c.id === history.head);
  if (headCommit && headCommit.snapshotHash === snapshotHash) {
    return headCommit;
  }

  await invoke("write_project_file", {
    path: snapshotPath(folder, snapshotHash),
    content,
  });

  const commit: Commit = {
    id: crypto.randomUUID(),
    parent: history.head,
    message,
    kind,
    author,
    createdAt: Date.now(),
    snapshotHash,
  };
  const next: HistoryFile = {
    version: 1,
    head: commit.id,
    commits: [...history.commits, commit],
  };
  await writeHistory(folder, next);
  return commit;
}

/**
 * Read the snapshot a commit points at. Returns a full ProjectFileV1 the caller
 * can apply to the editor. Does NOT mutate head — call `setHead` after applying
 * so subsequent edits branch from the restored commit.
 */
export async function restoreVersion(folder: string, commitId: string): Promise<ProjectFileV1> {
  const history = await loadHistory(folder);
  const commit = history.commits.find((c) => c.id === commitId);
  if (!commit) throw new Error(`Unknown commit: ${commitId}`);
  const text = await invoke<string>("read_project_file", {
    path: snapshotPath(folder, commit.snapshotHash),
  });
  return JSON.parse(text) as ProjectFileV1;
}

/** Move head to an existing commit (used right after restoreVersion applies). */
export async function setHead(folder: string, commitId: string): Promise<void> {
  const history = await loadHistory(folder);
  if (!history.commits.some((c) => c.id === commitId)) return;
  await writeHistory(folder, { ...history, head: commitId });
}

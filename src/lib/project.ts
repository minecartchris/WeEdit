import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useEditor } from "@/state/editor";
import type { Clip, MediaItem, ProjectMeta, Track } from "@/types";

// On-disk project format. The folder layout is:
//   <name>.weedit/
//     project.json     ← this file
//     cache/           ← future use: thumbnails, proxies, waveforms
//
// Forward slashes are used everywhere — Rust's Path handles mixed separators on
// Windows, so we don't bother joining via @tauri-apps/api/path.

export interface ProjectFileV1 {
  version: 1;
  project: ProjectMeta;
  media: MediaItem[];
  tracks: Track[];
  clips: Record<string, Clip>;
  savedAt: number;
}

const PROJECT_EXT = "weedit";
const PROJECT_FILE = "project.json";

function ensureWeeditExt(path: string): string {
  return path.toLowerCase().endsWith(`.${PROJECT_EXT}`) ? path : `${path}.${PROJECT_EXT}`;
}

function projectJsonPath(folder: string): string {
  return `${folder}/${PROJECT_FILE}`;
}

function cacheDirPath(folder: string): string {
  return `${folder}/cache`;
}

// ── Dialogs ────────────────────────────────────────────────────────────────

async function pickSaveLocation(suggestedName: string): Promise<string | null> {
  const result = await saveDialog({
    title: "Save WeEdit Project",
    defaultPath: `${suggestedName}.${PROJECT_EXT}`,
    filters: [{ name: "WeEdit Project", extensions: [PROJECT_EXT] }],
  });
  if (!result) return null;
  return ensureWeeditExt(result);
}

async function pickOpenLocation(): Promise<string | null> {
  const result = await openDialog({
    title: "Open WeEdit Project (pick the .weedit folder)",
    directory: true,
    multiple: false,
  });
  return Array.isArray(result) ? (result[0] ?? null) : result;
}

// ── Read / write ───────────────────────────────────────────────────────────

async function readProjectFromFolder(folder: string): Promise<ProjectFileV1> {
  const text = await invoke<string>("read_project_file", { path: projectJsonPath(folder) });
  const data = JSON.parse(text) as ProjectFileV1;
  if (data.version !== 1) {
    throw new Error(`Unsupported project version: ${(data as { version: unknown }).version}`);
  }
  return data;
}

async function writeProjectToFolder(folder: string, file: ProjectFileV1): Promise<void> {
  await invoke("ensure_dir", { path: folder });
  await invoke("ensure_dir", { path: cacheDirPath(folder) });
  await invoke("write_project_file", {
    path: projectJsonPath(folder),
    content: JSON.stringify(file, null, 2),
  });
}

function snapshotForFile(): ProjectFileV1 {
  const s = useEditor.getState();
  return {
    version: 1,
    project: s.project,
    media: s.media,
    tracks: s.tracks,
    clips: s.clips,
    savedAt: Date.now(),
  };
}

// ── Public actions ─────────────────────────────────────────────────────────

export async function saveProject(): Promise<void> {
  const path =
    useEditor.getState().projectPath ??
    (await pickSaveLocation(useEditor.getState().project.name));
  if (!path) return;
  const file = snapshotForFile();
  await writeProjectToFolder(path, file);
  useEditor.getState().setProjectPath(path);
  useEditor.getState().setLastSavedAt(file.savedAt);
}

export async function saveProjectAs(): Promise<void> {
  const path = await pickSaveLocation(useEditor.getState().project.name);
  if (!path) return;
  const file = snapshotForFile();
  await writeProjectToFolder(path, file);
  useEditor.getState().setProjectPath(path);
  useEditor.getState().setLastSavedAt(file.savedAt);
}

export async function openProject(): Promise<void> {
  const path = await pickOpenLocation();
  if (!path) return;
  const data = await readProjectFromFolder(path);
  useEditor.getState().applyLoadedProject(
    {
      project: data.project,
      media: data.media,
      tracks: data.tracks,
      clips: data.clips,
    },
    path,
    data.savedAt,
  );
}

export function newProject(): void {
  useEditor.getState().resetProject();
}

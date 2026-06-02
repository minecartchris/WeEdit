import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Bell,
  FileDown,
  FilePlus,
  FolderOpen,
  HelpCircle,
  History,
  Keyboard,
  Megaphone,
  Menu as MenuIcon,
  Save,
  Settings,
  Undo2,
  UserPlus,
} from "lucide-react";
import { useEffect, useState } from "react";
import { CollabModal } from "@/components/CollabModal";
import { ExportModal } from "@/components/ExportModal";
import { GpuBadge } from "@/components/GpuBadge";
import { HistoryPanel } from "@/components/HistoryPanel";
import { SettingsModal } from "@/components/SettingsModal";
import { UpdaterDialog } from "@/components/UpdaterDialog";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import {
  newProject,
  openProject,
  openProjectFromPath,
  projectDisplayName,
  saveProject,
  saveProjectAs,
} from "@/lib/project";
import { useCollab } from "@/state/collab";
import { useEditor } from "@/state/editor";
import { useIntegrations } from "@/state/integrations";

// Top chrome bar. Logo + project title on the left, status & actions on the right.
export function TopBar() {
  const projectName = useEditor((s) => s.project.name);
  const setProjectName = useEditor((s) => s.setProjectName);
  const lastSavedAt = useEditor((s) => s.lastSavedAt);
  const projectPath = useEditor((s) => s.projectPath);
  const clipCount = useEditor((s) => Object.keys(s.clips).length);
  const undo = useEditor((s) => s.undo);
  const recentProjects = useIntegrations((s) => s.recentProjects);
  const clearRecentProjects = useIntegrations((s) => s.clearRecentProjects);
  const [exportOpen, setExportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [collabOpen, setCollabOpen] = useState(false);
  const [updaterOpen, setUpdaterOpen] = useState(false);
  const collabStatus = useCollab((s) => s.status);
  const peerCount = useCollab((s) => s.peerCount);
  // Silent updater check ~5s after launch — pops the dialog if an update is
  // available, stays quiet otherwise.
  const [autoUpdaterOpen, setAutoUpdaterOpen] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setAutoUpdaterOpen(true), 5000);
    return () => clearTimeout(t);
  }, []);

  const confirmNewProject = () => {
    if (clipCount === 0) {
      newProject();
      return;
    }
    if (window.confirm("Start a new project? Anything not saved will be discarded.")) {
      newProject();
    }
  };

  const openRecent = (path: string) => {
    void openProjectFromPath(path).catch((err) => {
      console.error("Failed to open recent project:", err);
      window.alert(`Couldn't open ${path}\n\n${err instanceof Error ? err.message : String(err)}`);
    });
  };

  const onClose = async () => {
    try {
      await getCurrentWindow().close();
    } catch (err) {
      console.warn("Failed to close window", err);
    }
  };

  const onRenameProject = () => {
    const next = window.prompt("Project name", projectName);
    if (next != null) {
      const trimmed = next.trim();
      if (trimmed) setProjectName(trimmed);
    }
  };

  const swallow = (fn: () => Promise<void> | void) => () => {
    void Promise.resolve()
      .then(() => fn())
      .catch((err) => console.error(err));
  };

  return (
    <header className="h-14 shrink-0 flex items-center gap-3 px-3 bg-we-panel border-b border-we-border">
      <div className="flex items-center gap-2 pr-2">
        <div className="w-8 h-8 rounded-md bg-we-teal text-white grid place-items-center font-semibold text-sm tracking-tight">
          we
        </div>
      </div>

      <Menu
        trigger={({ onClick, isOpen }) => (
          <button
            onClick={onClick}
            aria-expanded={isOpen}
            className="we-btn-ghost p-1.5"
            title="Menu"
            aria-label="Menu"
          >
            <MenuIcon className="w-5 h-5" />
          </button>
        )}
      >
        <MenuLabel>Project</MenuLabel>
        <MenuItem icon={FilePlus}   onSelect={confirmNewProject}       shortcut="Ctrl+N">New project</MenuItem>
        <MenuItem icon={FolderOpen} onSelect={swallow(openProject)}    shortcut="Ctrl+O">Open project…</MenuItem>
        <MenuItem icon={Save}       onSelect={swallow(saveProject)}    shortcut="Ctrl+S">Save project</MenuItem>
        <MenuItem icon={FileDown}   onSelect={swallow(saveProjectAs)}>Save project as…</MenuItem>
        <MenuItem icon={History}    onSelect={() => setHistoryOpen(true)}>Version history…</MenuItem>
        {recentProjects.length > 0 && (
          <>
            <MenuSeparator />
            <MenuLabel>Recent projects</MenuLabel>
            {recentProjects.slice(0, 8).map((p) => (
              <MenuItem key={p} onSelect={() => openRecent(p)}>
                {projectDisplayName(p)}
              </MenuItem>
            ))}
            <MenuItem onSelect={() => void clearRecentProjects()}>Clear recents</MenuItem>
          </>
        )}
        <MenuSeparator />
        <MenuLabel>Edit</MenuLabel>
        <MenuItem icon={Undo2}     onSelect={undo}              shortcut="Ctrl+Z">Undo</MenuItem>
        <MenuItem onSelect={onRenameProject}>Rename project…</MenuItem>
        <MenuSeparator />
        <MenuItem icon={Settings}  onSelect={() => setSettingsOpen(true)}>Settings…</MenuItem>
        <MenuItem icon={Keyboard}  onSelect={() => setSettingsOpen(true)}>Keyboard shortcuts</MenuItem>
        <MenuItem onSelect={() => setUpdaterOpen(true)}>Check for updates…</MenuItem>
      </Menu>

      <button
        onClick={onRenameProject}
        title="Rename project"
        className="text-lg font-medium text-we-ink ml-1 px-1 rounded hover:bg-we-hover"
      >
        {projectName}
      </button>

      <div className="flex items-center gap-2 pl-3">
        <button
          onClick={() => setCollabOpen(true)}
          className={[
            "h-7 px-2 rounded-full border grid grid-flow-col items-center gap-1 text-xs transition-colors",
            collabStatus === "connected"
              ? "border-we-teal text-we-teal bg-we-teal/10"
              : "border-dashed border-we-muted/60 text-we-muted hover:text-we-ink hover:border-solid",
          ].join(" ")}
          title={collabStatus === "connected" ? "Collaboration session" : "Invite collaborators"}
          aria-label="Collaborate"
        >
          <UserPlus className="w-3.5 h-3.5" />
          {collabStatus === "connected" && <span>{peerCount + 1}</span>}
        </button>
        <SaveStatus path={projectPath} savedAt={lastSavedAt} />
      </div>

      <div className="flex-1" />

      <GpuBadge />

      <div className="flex items-center gap-1">
        <Menu
          align="right"
          trigger={({ onClick }) => (
            <button onClick={onClick} className="we-btn-ghost p-2" title="Notifications" aria-label="Notifications">
              <Bell className="w-5 h-5" />
            </button>
          )}
        >
          <MenuLabel>Notifications</MenuLabel>
          <div className="px-3 py-3 text-sm text-we-muted text-center min-w-[220px]">
            You're all caught up.
          </div>
        </Menu>

        <button
          onClick={() => setSettingsOpen(true)}
          className="we-btn-ghost p-2"
          title="Settings"
          aria-label="Settings"
        >
          <Settings className="w-5 h-5" />
        </button>

        <Menu
          align="right"
          trigger={({ onClick }) => (
            <button onClick={onClick} className="we-btn-ghost p-2" title="Help" aria-label="Help">
              <HelpCircle className="w-5 h-5" />
            </button>
          )}
        >
          <MenuLabel>Help</MenuLabel>
          <div className="px-3 py-2 text-xs text-we-muted leading-5 max-w-[280px]">
            Shortcuts: <strong>Space</strong> play/pause, <strong>S</strong> split,
            <strong> Del</strong> delete, <strong>Ctrl+Z</strong> undo, <strong>Ctrl+Y</strong> redo,
            <strong> Ctrl+S</strong> save, <strong>Ctrl+O</strong> open, <strong>Ctrl+N</strong> new.
          </div>
          <MenuSeparator />
          <div className="px-3 py-1.5 text-[11px] text-we-muted">WeEdit · v0.0.1</div>
        </Menu>

        <Menu
          align="right"
          trigger={({ onClick }) => (
            <button onClick={onClick} className="we-btn-ghost p-2" title="What's new" aria-label="What's new">
              <Megaphone className="w-5 h-5" />
            </button>
          )}
        >
          <MenuLabel>What's new</MenuLabel>
          <div className="px-3 py-2 text-xs text-we-muted max-w-[260px] leading-5">
            Drop media onto a track, trim, split, undo. Save / open projects to disk
            with auto-save. Active video clip renders in the preview stage.
          </div>
        </Menu>
      </div>

      <button onClick={onClose} className="we-btn ml-1">Close</button>
      <button className="we-btn-primary" onClick={() => setExportOpen(true)}>Export</button>

      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <HistoryPanel open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <CollabModal open={collabOpen} onClose={() => setCollabOpen(false)} />
      <UpdaterDialog open={updaterOpen} onClose={() => setUpdaterOpen(false)} />
      <UpdaterDialog open={autoUpdaterOpen} onClose={() => setAutoUpdaterOpen(false)} silentIfUpToDate />
    </header>
  );
}

// "Last saved a second ago" / "Not saved" status. Re-renders every 5s so the
// relative timestamp stays current.
function SaveStatus({
  path,
  savedAt,
}: {
  path: string | null;
  savedAt: number | null;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(t);
  }, []);

  let text: string;
  if (path == null) text = "Not yet saved — Ctrl+S to save";
  else if (savedAt == null) text = "Unsaved changes";
  else text = `Last saved ${formatRelative(savedAt, now)}`;

  return <span className="text-sm text-we-muted">{text}</span>;
}

function formatRelative(t: number, now: number): string {
  const sec = Math.max(0, (now - t) / 1000);
  if (sec < 5)     return "a moment ago";
  if (sec < 60)    return `${Math.floor(sec)} seconds ago`;
  const min = sec / 60;
  if (min < 2)     return "a minute ago";
  if (min < 60)    return `${Math.floor(min)} minutes ago`;
  const h = min / 60;
  if (h < 2)       return "an hour ago";
  if (h < 24)      return `${Math.floor(h)} hours ago`;
  const d = h / 24;
  return d < 2 ? "a day ago" : `${Math.floor(d)} days ago`;
}

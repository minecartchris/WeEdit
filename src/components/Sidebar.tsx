import {
  Box,
  ChevronLeft,
  ChevronRight,
  FileVideo,
  HardDrive,
  Image as ImageIcon,
  Layers,
  Music,
  Repeat,
  Smile,
  Tv,
  Type,
  UploadCloud,
  Video,
  type LucideIcon,
} from "lucide-react";
import { useEditor } from "@/state/editor";
import { usePrefs } from "@/state/prefs";
import type { LibraryFilter } from "@/types";

interface SidebarItem {
  key: LibraryFilter;
  label: string;
  icon: LucideIcon;
}

const items: SidebarItem[] = [
  { key: "project-bin",  label: "Project bin",  icon: Box },
  { key: "uploads",      label: "Uploads",      icon: UploadCloud },
  { key: "twitch",       label: "Twitch",       icon: Tv },
  { key: "nas",          label: "NAS",          icon: HardDrive },
  { key: "exports",      label: "Exports",      icon: FileVideo },
  { key: "videos",       label: "Videos",       icon: Video },
  { key: "images",       label: "Images",       icon: ImageIcon },
  { key: "audio",        label: "Audio",        icon: Music },
  { key: "text",         label: "Text",         icon: Type },
  { key: "transitions",  label: "Transitions",  icon: Repeat },
  { key: "extras",       label: "Extras",       icon: Smile },
  { key: "backgrounds",  label: "Backgrounds",  icon: Layers },
];

export function Sidebar() {
  const active = useEditor((s) => s.libraryFilter);
  const setActive = useEditor((s) => s.setLibraryFilter);
  // Collapsing to icons only gives the preview the rail's width back without
  // shrinking the media list itself. The choice persists across sessions, since
  // once you know the icons you never want the labels again.
  const showLabels = usePrefs((s) => s.sidebarLabels);
  const setShowLabels = usePrefs((s) => s.setSidebarLabels);

  return (
    <aside
      className={[
        "shrink-0 bg-we-rail border-r border-we-border py-3 flex flex-col",
        showLabels ? "w-52" : "w-14",
      ].join(" ")}
    >
      <nav className="flex flex-col">
        {items.map(({ key, label, icon: Icon }) => {
          const isActive = active === key;
          return (
            <button
              key={key}
              onClick={() => setActive(key)}
              title={showLabels ? undefined : label}
              aria-label={label}
              className={[
                "flex items-center gap-2.5 py-2 text-sm transition-colors",
                showLabels ? "px-4" : "px-0 justify-center",
                isActive
                  ? "bg-we-teal/10 text-we-ink font-medium"
                  : "text-we-ink hover:bg-we-hover",
              ].join(" ")}
            >
              <Icon className={["w-4 h-4 shrink-0", isActive ? "text-we-teal" : "text-we-muted"].join(" ")} />
              {showLabels && <span className="truncate">{label}</span>}
            </button>
          );
        })}
      </nav>

      <button
        onClick={() => setShowLabels(!showLabels)}
        title={showLabels ? "Hide tab names" : "Show tab names"}
        aria-label={showLabels ? "Hide tab names" : "Show tab names"}
        className={[
          "mt-auto flex items-center gap-2.5 py-2 text-xs text-we-muted hover:bg-we-hover hover:text-we-ink transition-colors",
          showLabels ? "px-4" : "px-0 justify-center",
        ].join(" ")}
      >
        {showLabels ? (
          <>
            <ChevronLeft className="w-4 h-4 shrink-0" />
            <span>Hide names</span>
          </>
        ) : (
          <ChevronRight className="w-4 h-4 shrink-0" />
        )}
      </button>
    </aside>
  );
}

import {
  Box,
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

  return (
    <aside className="w-52 shrink-0 bg-we-rail border-r border-we-border py-3">
      <nav className="flex flex-col">
        {items.map(({ key, label, icon: Icon }) => {
          const isActive = active === key;
          return (
            <button
              key={key}
              onClick={() => setActive(key)}
              className={[
                "flex items-center gap-2.5 px-4 py-2 text-sm transition-colors",
                isActive
                  ? "bg-we-teal/10 text-we-ink font-medium"
                  : "text-we-ink hover:bg-slate-100",
              ].join(" ")}
            >
              <Icon className={["w-4 h-4", isActive ? "text-we-teal" : "text-we-muted"].join(" ")} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
    </aside>
  );
}

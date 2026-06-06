import { isTauri } from "@/lib/platform";
import {
  ChevronDown,
  Film,
  HardDrive,
  Image as ImageIcon,
  Music,
  Plus,
  Tv,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AudioPanel } from "@/components/AudioPanel";
import { LibraryPanel } from "@/components/LibraryPanel";
import { NasPanel } from "@/components/NasPanel";
import { StockPanel } from "@/components/StockPanel";
import { TextPanel } from "@/components/TextPanel";
import { TwitchPanel } from "@/components/TwitchPanel";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "@/components/ui/Menu";
import { isMediaCompatibleWithTrack, makeClipFromMedia } from "@/lib/clips";
import { startMediaDrag } from "@/lib/customDrag";
import { importFile, importPath, pickMediaFiles, pickMediaFilesWeb } from "@/lib/media";
import { isWeb } from "@/lib/platform";
import { formatDuration, useEditor } from "@/state/editor";
import type { LibraryFilter, MediaItem } from "@/types";

type MediaTab = LibraryFilter;

// Filters that map to actual media kinds. Other tabs render their own panels
// (text, transitions, extras, backgrounds, uploads, exports — all stubbed).
function filterMedia(items: MediaItem[], tab: MediaTab): MediaItem[] {
  switch (tab) {
    case "project-bin": return items;
    default:            return [];
  }
}

export function MediaLibrary() {
  const media = useEditor((s) => s.media);
  const addMedia = useEditor((s) => s.addMedia);
  const tab = useEditor((s) => s.libraryFilter);
  const setLibraryFilter = useEditor((s) => s.setLibraryFilter);
  const [hideUsed, setHideUsed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const importMany = useCallback(
    async (paths: string[]) => {
      if (paths.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const p of paths) {
          try {
            const item = await importPath(p);
            if (item) addMedia(item);
          } catch (err) {
            console.warn("Import failed for", p, err);
            setError(`Failed: ${p.split(/[\\/]/).pop()}`);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [addMedia],
  );

  const importFiles = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        for (const f of files) {
          try {
            const item = await importFile(f);
            if (item) addMedia(item);
          } catch (err) {
            console.warn("Import failed for", f.name, err);
            setError(`Failed: ${f.name}`);
          }
        }
      } finally {
        setBusy(false);
      }
    },
    [addMedia],
  );

  useEffect(() => {
    if (!isTauri()) return;
    const unlistenP = import("@tauri-apps/api/webview").then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "over" || p.type === "enter") setDragOver(true);
        else if (p.type === "leave") setDragOver(false);
        else if (p.type === "drop") {
          setDragOver(false);
          if (p.paths && p.paths.length > 0) void importMany(p.paths);
        }
      }),
    );
    return () => {
      unlistenP.then((u) => u()).catch(() => {});
    };
  }, [importMany]);

  const clipsMap = useEditor((s) => s.clips);
  const usedMediaIds = useMemo(() => {
    const ids = new Set<string>();
    for (const c of Object.values(clipsMap)) {
      if (c.kind === "text") continue;
      ids.add((c as { mediaId: string }).mediaId);
    }
    return ids;
  }, [clipsMap]);

  const visible = useMemo(() => {
    let items = filterMedia(media, tab);
    if (hideUsed) items = items.filter((m) => !usedMediaIds.has(m.id));
    return items;
  }, [media, tab, hideUsed, usedMediaIds]);

  const handleAddMedia = async (
    source: "device" | "record" | "url" | "twitch" | "nas",
  ) => {
    if (source === "device") {
      if (isWeb()) {
        const files = await pickMediaFilesWeb();
        void importFiles(files);
      } else {
        const paths = await pickMediaFiles();
        void importMany(paths);
      }
    } else if (source === "twitch") {
      setLibraryFilter("twitch");
    } else if (source === "nas") {
      setLibraryFilter("nas");
    } else {
      setError(`${source === "record" ? "Recording" : "URL import"} coming in a later phase`);
      setTimeout(() => setError(null), 2500);
    }
  };

  // Source-style tabs render full-panel content, not the standard library grid.
  if (tab === "twitch") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <TwitchPanel />
      </section>
    );
  }
  if (tab === "nas") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <NasPanel />
      </section>
    );
  }
  if (tab === "videos") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <StockPanel kind="video" />
      </section>
    );
  }
  if (tab === "images") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <StockPanel kind="image" />
      </section>
    );
  }
  if (tab === "audio") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <AudioPanel />
      </section>
    );
  }
  if (tab === "text") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <TextPanel />
      </section>
    );
  }
  // Persistent user library categories — upload your own files, kept across
  // sessions. (The Videos/Images/Audio tabs keep their stock browsers.)
  if (tab === "uploads" || tab === "backgrounds" || tab === "extras" || tab === "transitions") {
    return (
      <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
        <LibraryPanel category={tab} />
      </section>
    );
  }

  return (
    <section className="flex-1 min-w-0 bg-we-panel border-r border-we-border flex flex-col">
      <div className="h-12 shrink-0 flex items-center gap-4 px-4 border-b border-we-border">
        <Menu
          trigger={({ onClick }) => (
            <button
              onClick={onClick}
              disabled={busy}
              className="inline-flex items-center gap-1.5 text-we-teal text-sm font-medium hover:text-we-tealHover disabled:opacity-50"
            >
              <Plus className="w-4 h-4" />
              {busy ? "Importing…" : "Add media"}
              <ChevronDown className="w-3.5 h-3.5" />
            </button>
          )}
        >
          <MenuLabel>Add media</MenuLabel>
          <MenuItem icon={Upload} onSelect={() => handleAddMedia("device")}>
            From this device…
          </MenuItem>
          <MenuItem icon={HardDrive} onSelect={() => handleAddMedia("nas")}>
            From NAS…
          </MenuItem>
          <MenuItem icon={Tv} onSelect={() => handleAddMedia("twitch")}>
            From Twitch VODs…
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Film} onSelect={() => handleAddMedia("record")} disabled>
            Record screen / cam
          </MenuItem>
          <MenuItem icon={ImageIcon} onSelect={() => handleAddMedia("url")} disabled>
            Import from URL
          </MenuItem>
        </Menu>

        <div className="ml-auto flex items-center gap-2">
          <span className="text-sm text-we-muted">Hide used media</span>
          <button
            role="switch"
            aria-checked={hideUsed}
            onClick={() => setHideUsed((v) => !v)}
            className={[
              "relative w-9 h-5 rounded-full transition-colors",
              hideUsed ? "bg-we-teal" : "bg-we-border",
            ].join(" ")}
          >
            <span
              className={[
                "absolute top-0.5 w-4 h-4 rounded-full bg-we-panel shadow transition-all",
                hideUsed ? "left-[18px]" : "left-0.5",
              ].join(" ")}
            />
          </button>
        </div>
      </div>

      {error && (
        <div className="px-4 py-1.5 text-xs text-red-700 bg-red-50 border-b border-red-100">
          {error}
        </div>
      )}

      <div
        className={[
          "flex-1 p-4 overflow-auto transition-colors",
          dragOver ? "bg-we-teal/5" : "",
        ].join(" ")}
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files.length > 0) {
            void importFiles(Array.from(e.dataTransfer.files));
          }
        }}
      >
        <LibraryView tab={tab} items={visible} dragOver={dragOver} onPick={() => handleAddMedia("device")} />
      </div>
    </section>
  );
}

function LibraryView({
  tab,
  items,
  dragOver,
  onPick,
}: {
  tab: MediaTab;
  items: MediaItem[];
  dragOver: boolean;
  onPick: () => void;
}) {
  // Stub tabs that don't have a media list yet
  if (tab === "uploads" || tab === "exports") {
    return <StubPanel title={tab === "uploads" ? "Uploads" : "Exports"} hint="No items yet." />;
  }
  if (tab === "transitions") return <StubPanel title="Transitions" hint="Cut, fade, dissolve (next slice)." />;
  if (tab === "extras")      return <StubPanel title="Extras"      hint="Stickers and emoji overlays (later)." />;
  if (tab === "backgrounds") return <StubPanel title="Backgrounds" hint="Solid colors and gradient backdrops (later)." />;

  if (items.length === 0) {
    return <EmptyDropzone dragOver={dragOver} onClick={onPick} />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
      {items.map((m) => (
        <MediaCard key={m.id} item={m} />
      ))}
    </div>
  );
}

function MediaCard({ item }: { item: MediaItem }) {
  const removeMedia = useEditor((s) => s.removeMedia);

  const addToTimeline = () => {
    const state = useEditor.getState();
    const target = state.tracks.find((t) => isMediaCompatibleWithTrack(item.kind, t));
    if (!target) {
      console.warn(`No compatible track for ${item.kind} media; add a track first.`);
      return;
    }
    state.addClip(makeClipFromMedia(item, target.id, state.playheadSec));
  };

  return (
    <div
      className="group select-none rounded-lg border border-we-border overflow-hidden bg-we-panel hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
      title={`${item.name} — drag to a track, or double-click to add at playhead`}
      onMouseDown={(e) => startMediaDrag(e, item)}
      onDoubleClick={addToTimeline}
    >
      <div className="aspect-video bg-slate-900 grid place-items-center relative overflow-hidden pointer-events-none">
        {item.thumbnail ? (
          <img
            src={item.thumbnail}
            alt=""
            draggable={false}
            className="w-full h-full object-cover pointer-events-none"
          />
        ) : (
          <KindIcon kind={item.kind} />
        )}
        {item.durationSec != null && (
          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] tabular-nums">
            {formatDuration(item.durationSec)}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeMedia(item.id);
          }}
          draggable={false}
          className="absolute top-1 right-1 px-1.5 py-0.5 rounded text-[10px] bg-black/60 text-white opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity hover:bg-red-600"
          title="Remove from project"
        >
          Remove
        </button>
      </div>
      <div className="px-2 py-1.5 text-xs text-we-ink truncate">{item.name}</div>
    </div>
  );
}

function KindIcon({ kind }: { kind: MediaItem["kind"] }) {
  const Icon = kind === "video" ? Film : kind === "audio" ? Music : ImageIcon;
  return <Icon className="w-8 h-8 text-we-muted" />;
}

function StubPanel({ title, hint, icon: Icon }: { title: string; hint: string; icon?: LucideIconLike }) {
  return (
    <div className="h-full grid place-items-center text-we-muted text-sm">
      <div className="flex flex-col items-center gap-2">
        {Icon ? <Icon className="w-8 h-8" /> : null}
        <strong className="text-we-ink font-medium">{title}</strong>
        <span>{hint}</span>
      </div>
    </div>
  );
}
type LucideIconLike = React.ComponentType<{ className?: string }>;

function EmptyDropzone({ dragOver, onClick }: { dragOver: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={[
        "w-full h-full min-h-[260px] rounded-lg border-2 border-dashed grid place-items-center transition-colors",
        dragOver
          ? "border-we-teal bg-we-teal/5 text-we-teal"
          : "border-we-border text-we-muted hover:border-we-teal/60 hover:text-we-teal",
      ].join(" ")}
    >
      <div className="flex flex-col items-center gap-3">
        <DropzoneArt />
        <p className="text-sm">
          {dragOver ? "Drop to import" : "Drag and drop your media here, or click to browse"}
        </p>
      </div>
    </button>
  );
}

function DropzoneArt() {
  return (
    <svg width="190" height="140" viewBox="0 0 190 140" fill="none" aria-hidden>
      <g opacity="0.85">
        <rect x="22" y="36" width="62" height="60" rx="6" fill="#e2e8f0" />
        <path d="M30 86l16-18 12 14 8-9 14 16H30z" fill="#94a3b8" />
        <circle cx="45" cy="54" r="6" fill="#cbd5e1" />
      </g>
      <g>
        <rect x="68" y="22" width="74" height="56" rx="8" fill="#1aa6b7" />
        <path d="M93 36l22 14-22 14V36z" fill="#fff" />
      </g>
      <g opacity="0.85">
        <rect x="118" y="58" width="50" height="50" rx="8" fill="#e2e8f0" />
        <path d="M132 78v-12l16 4v12" stroke="#64748b" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <circle cx="132" cy="86" r="3.5" fill="#64748b" />
        <circle cx="148" cy="90" r="3.5" fill="#64748b" />
      </g>
      <g stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round">
        <path d="M14 12l4 4M16 14l-2 2M16 14l2-2" />
        <path d="M170 12l4 4M172 14l-2 2M172 14l2-2" />
        <circle cx="106" cy="6" r="2" fill="#94a3b8" />
        <circle cx="178" cy="48" r="2" fill="#94a3b8" />
        <circle cx="100" cy="120" r="2" fill="#94a3b8" />
      </g>
    </svg>
  );
}

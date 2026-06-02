import { Film, Image as ImageIcon, Music, Plus, Trash2, Upload } from "lucide-react";
import { useMemo } from "react";
import { isMediaCompatibleWithTrack, makeClipFromMedia } from "@/lib/clips";
import { startDragWithSource } from "@/lib/customDrag";
import { pickMediaFiles } from "@/lib/media";
import { formatDuration, useEditor } from "@/state/editor";
import { useLibrary, type LibraryCategory, type LibraryItem } from "@/state/library";
import type { MediaItem } from "@/types";

// Panel for one persistent-library category (Uploads / Backgrounds / Extras /
// Transitions). Files added here are kept across sessions; cards drag onto the
// timeline (or double-click to add at the playhead) like the project bin.

const META: Record<LibraryCategory, { title: string; blurb: string }> = {
  uploads: { title: "Uploads", blurb: "Your own video, image, and audio files — kept across sessions." },
  backgrounds: { title: "Backgrounds", blurb: "Background images & loops you reuse across projects." },
  extras: { title: "Extras", blurb: "Stickers, overlays, and other extras you upload." },
  transitions: { title: "Transitions", blurb: "Transition clips/overlays you keep on hand." },
};

export function LibraryPanel({ category }: { category: LibraryCategory }) {
  const allItems = useLibrary((s) => s.items);
  const addFiles = useLibrary((s) => s.addFiles);
  const busy = useLibrary((s) => s.busy);

  const items = useMemo(
    () => allItems.filter((i) => i.category === category).sort((a, b) => b.addedAt - a.addedAt),
    [allItems, category],
  );
  const meta = META[category];

  const onAdd = async () => {
    const paths = await pickMediaFiles();
    await addFiles(paths, category);
  };

  return (
    <div className="flex flex-col h-full">
      <div className="h-12 shrink-0 flex items-center gap-3 px-4 border-b border-we-border">
        <button
          onClick={onAdd}
          disabled={busy}
          className="inline-flex items-center gap-1.5 text-we-teal text-sm font-medium hover:text-we-tealHover disabled:opacity-50"
        >
          <Plus className="w-4 h-4" />
          {busy ? "Importing…" : "Add files"}
        </button>
        <div className="ml-auto text-[11px] text-we-muted truncate" title={meta.blurb}>
          {meta.title}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {items.length === 0 ? (
          <EmptyLibrary blurb={meta.blurb} onAdd={onAdd} />
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
            {items.map((item) => (
              <LibraryCard key={item.id} item={item} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Clone a stored library MediaItem into the current project with a fresh id so
// each project owns its own media entry (the library keeps the original).
function cloneForProject(media: MediaItem): MediaItem {
  return { ...media, id: crypto.randomUUID(), importedAt: Date.now() };
}

function LibraryCard({ item }: { item: LibraryItem }) {
  const removeItem = useLibrary((s) => s.removeItem);
  const media = item.media;

  const onDragStart = (e: React.MouseEvent) => {
    startDragWithSource(e, {
      kind: media.kind,
      label: media.name,
      resolve: async () => {
        const fresh = cloneForProject(media);
        useEditor.getState().addMedia(fresh);
        return fresh;
      },
    });
  };

  const addAtPlayhead = () => {
    const state = useEditor.getState();
    const target = state.tracks.find((t) => isMediaCompatibleWithTrack(media.kind, t));
    if (!target) {
      console.warn(`No compatible track for ${media.kind}; add a track first.`);
      return;
    }
    const fresh = cloneForProject(media);
    state.addMedia(fresh);
    state.addClip(makeClipFromMedia(fresh, target.id, state.playheadSec));
  };

  return (
    <div
      className="group select-none rounded-lg border border-we-border overflow-hidden bg-we-panel hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing"
      title={`${media.name} — drag to a track, or double-click to add at playhead`}
      onMouseDown={onDragStart}
      onDoubleClick={addAtPlayhead}
    >
      <div className="aspect-video bg-slate-900 grid place-items-center relative overflow-hidden pointer-events-none">
        {media.thumbnail ? (
          <img src={media.thumbnail} alt="" draggable={false} className="w-full h-full object-cover" />
        ) : (
          <KindIcon kind={media.kind} />
        )}
        {media.durationSec != null && (
          <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] tabular-nums">
            {formatDuration(media.durationSec)}
          </span>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            removeItem(item.id);
          }}
          draggable={false}
          className="absolute top-1 right-1 px-1 py-1 rounded text-[10px] bg-black/60 text-white opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto transition-opacity hover:bg-red-600"
          title="Remove from library"
        >
          <Trash2 className="w-3 h-3" />
        </button>
      </div>
      <div className="px-2 py-1.5 text-xs text-we-ink truncate">{media.name}</div>
    </div>
  );
}

function KindIcon({ kind }: { kind: MediaItem["kind"] }) {
  const Icon = kind === "video" ? Film : kind === "audio" ? Music : ImageIcon;
  return <Icon className="w-8 h-8 text-we-muted" />;
}

function EmptyLibrary({ blurb, onAdd }: { blurb: string; onAdd: () => void }) {
  return (
    <button
      onClick={onAdd}
      className="w-full h-full min-h-[240px] rounded-lg border-2 border-dashed border-we-border grid place-items-center text-we-muted hover:border-we-teal/60 hover:text-we-teal transition-colors"
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <Upload className="w-8 h-8" />
        <p className="text-sm">{blurb}</p>
        <span className="text-xs">Click to add files</span>
      </div>
    </button>
  );
}

import { isMediaCompatibleWithTrack, makeClipFromMedia } from "@/lib/clips";
import { basename, classifyByExt, importPath } from "@/lib/media";
import { useEditor } from "@/state/editor";
import type { MediaItem, MediaKind } from "@/types";

// Bespoke mousedown/mousemove/mouseup drag controller for library→timeline and
// NAS-row→timeline drops. We don't use HTML5 drag-and-drop because WebView2
// has been unreliable for us; this implementation uses raw mouse coordinates +
// `document.elementFromPoint` to find the target track lane.
//
// The controller supports a "lazy" DragSource so a NAS file row can begin a
// drag without paying the import cost up front — `resolve()` runs on drop and
// produces the MediaItem just before the clip is created.

const DRAG_THRESHOLD_PX = 4;

/** What's being dragged. `resolve()` runs on drop (may be async). */
export interface DragSource {
  kind: MediaKind;
  /** Shown on the floating "ghost" element. */
  label: string;
  /** Returns the MediaItem to drop. Null = cancel (e.g. import failed). */
  resolve(): Promise<MediaItem | null>;
}

interface PendingDrag {
  source: DragSource;
  startX: number;
  startY: number;
}

interface ActiveDrag {
  source: DragSource;
}

let pending: PendingDrag | null = null;
let active: ActiveDrag | null = null;
let ghost: HTMLDivElement | null = null;

// ── Public starters ─────────────────────────────────────────────────────────

/** Drag an already-imported MediaItem (used by library cards). */
export function startMediaDrag(e: React.MouseEvent, item: MediaItem): void {
  startDrag(e, {
    kind: item.kind,
    label: item.name,
    resolve: async () => item,
  });
}

/**
 * Drag a not-yet-imported file (used by NAS file rows, etc). On drop, the
 * file is imported via `importPath()` and added to the media library — and
 * also turned into a clip on the target track.
 */
export function startNasFileDrag(e: React.MouseEvent, filePath: string): void {
  const name = basename(filePath);
  const kind = classifyByExt(name);
  if (!kind) return; // not a media file — don't initiate drag, let click handlers run
  startDrag(e, {
    kind,
    label: name,
    resolve: async () => {
      const item = await importPath(filePath);
      if (item) useEditor.getState().addMedia(item);
      return item;
    },
  });
}

/** Drag using a caller-provided DragSource — used by stock browsers, etc. */
export function startDragWithSource(e: React.MouseEvent, source: DragSource): void {
  startDrag(e, source);
}

// ── Core controller ─────────────────────────────────────────────────────────

function startDrag(e: React.MouseEvent, source: DragSource): void {
  if (e.button !== 0) return;
  const target = e.target as HTMLElement;
  if (target.closest("button, input, a, select")) return;

  pending = { source, startX: e.clientX, startY: e.clientY };
  document.addEventListener("mousemove", onMove);
  document.addEventListener("mouseup", onUp);
  document.addEventListener("keydown", onKey);
}

function onMove(e: MouseEvent) {
  if (pending) {
    const dx = e.clientX - pending.startX;
    const dy = e.clientY - pending.startY;
    if (dx * dx + dy * dy < DRAG_THRESHOLD_PX * DRAG_THRESHOLD_PX) return;
    promoteToActive(pending.source);
    pending = null;
  }
  if (active) {
    positionGhost(e.clientX, e.clientY);
    const lane = findLaneAt(e.clientX, e.clientY);
    useEditor.getState().setHoverTrackId(lane?.trackId ?? null);
  }
}

function onUp(e: MouseEvent) {
  if (pending) {
    pending = null;
    detach();
    return;
  }
  if (!active) {
    detach();
    return;
  }

  const session = active;
  cleanupGhostAndState();
  detach();

  const lane = findLaneAt(e.clientX, e.clientY);
  if (!lane) return;

  const state = useEditor.getState();
  const track = state.tracks.find((t) => t.id === lane.trackId);
  if (!track) return;
  if (!isMediaCompatibleWithTrack(session.source.kind, track)) return;

  const rect = lane.el.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const t = Math.max(0, x / state.pxPerSec);

  void resolveAndAddClip(session.source, track.id, t);
}

async function resolveAndAddClip(source: DragSource, trackId: string, startSec: number) {
  try {
    const item = await source.resolve();
    if (!item) return;
    useEditor.getState().addClip(makeClipFromMedia(item, trackId, startSec));
  } catch (err) {
    console.error("Drag drop resolve failed:", err);
  }
}

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape") return;
  if (active) cleanupGhostAndState();
  pending = null;
  detach();
}

function promoteToActive(source: DragSource) {
  active = { source };
  ghost = document.createElement("div");
  ghost.setAttribute("data-weedit-drag-ghost", "");
  ghost.textContent = source.label;
  Object.assign(ghost.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "9999",
    padding: "6px 12px",
    borderRadius: "6px",
    background: "rgba(26, 166, 183, 0.92)",
    color: "white",
    fontSize: "12px",
    fontWeight: "500",
    fontFamily: "system-ui, sans-serif",
    boxShadow: "0 4px 16px rgba(0, 0, 0, 0.25)",
    maxWidth: "240px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    left: "-9999px",
    top: "-9999px",
  } as CSSStyleDeclaration);
  document.body.appendChild(ghost);
  useEditor.getState().beginDragSession("__pending__", source.kind);
}

function positionGhost(x: number, y: number) {
  if (!ghost) return;
  ghost.style.left = `${x + 14}px`;
  ghost.style.top = `${y + 14}px`;
}

function findLaneAt(x: number, y: number): { el: HTMLElement; trackId: string } | null {
  let prevDisplay: string | undefined;
  if (ghost) {
    prevDisplay = ghost.style.display;
    ghost.style.display = "none";
  }
  const hit = document.elementFromPoint(x, y);
  if (ghost) ghost.style.display = prevDisplay ?? "";

  if (!hit) return null;
  const lane = (hit as HTMLElement).closest<HTMLElement>("[data-track-id]");
  if (!lane || !lane.dataset.trackId) return null;
  return { el: lane, trackId: lane.dataset.trackId };
}

function cleanupGhostAndState() {
  if (ghost) {
    ghost.remove();
    ghost = null;
  }
  active = null;
  useEditor.getState().endDragSession();
  useEditor.getState().setHoverTrackId(null);
}

function detach() {
  document.removeEventListener("mousemove", onMove);
  document.removeEventListener("mouseup", onUp);
  document.removeEventListener("keydown", onKey);
}

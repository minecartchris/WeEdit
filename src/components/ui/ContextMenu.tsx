import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { type LucideIcon } from "lucide-react";

// Right-click context menu. Differs from `Menu` (which has a click-to-open
// trigger anchor) — this one is opened by the caller with explicit cursor
// coordinates and positioned via fixed positioning. Portal'd to <body> so it
// renders above any clipping ancestor.

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
}

const VIEWPORT_PADDING = 8;

export function ContextMenu({ x, y, onClose, children }: ContextMenuProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>({
    top: 0,
    left: 0,
    ready: false,
  });

  // Position the panel inside the viewport, flipping above / left if needed.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = y;
    let left = x;
    if (top + rect.height > vh - VIEWPORT_PADDING) {
      top = Math.max(VIEWPORT_PADDING, y - rect.height);
    }
    if (left + rect.width > vw - VIEWPORT_PADDING) {
      left = Math.max(VIEWPORT_PADDING, x - rect.width);
    }
    setPos({ top, left, ready: true });
  }, [x, y]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    // Treat the right-click that opens *another* element as also closing this.
    const onContext = (e: MouseEvent) => {
      if (panelRef.current?.contains(e.target as Node)) return;
      onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("contextmenu", onContext);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("contextmenu", onContext);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={panelRef}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
      // The menu is portaled to <body>, but React still bubbles its events
      // through the component tree to whatever rendered it (e.g. a ClipBlock
      // whose onPointerDown starts a drag). Stop pointer/mouse/click here so a
      // menu-item press can't be hijacked into a drag gesture, which would
      // swallow the item's click and make every action silently no-op.
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      className="fixed z-[1100] min-w-[200px] rounded-md bg-we-panel border border-we-border shadow-lg py-1"
      style={{
        top: pos.ready ? pos.top : -9999,
        left: pos.ready ? pos.left : -9999,
        visibility: pos.ready ? "visible" : "hidden",
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

interface ContextMenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

export function ContextMenuItem({
  children,
  onSelect,
  icon: Icon,
  danger,
  disabled,
  shortcut,
}: ContextMenuItemProps) {
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={(e) => {
        if (disabled) return;
        e.stopPropagation();
        onSelect?.();
      }}
      className={[
        "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
        disabled
          ? "text-we-muted/60 cursor-not-allowed"
          : danger
          ? "text-red-600 hover:bg-red-50"
          : "text-we-ink hover:bg-we-hover",
      ].join(" ")}
    >
      {Icon ? <Icon className="w-4 h-4" /> : <span className="w-4" />}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[11px] text-we-muted tabular-nums">{shortcut}</span>}
    </button>
  );
}

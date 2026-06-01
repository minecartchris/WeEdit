import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { type LucideIcon } from "lucide-react";

// Tiny dropdown primitive. Panel is portaled to <body> and positioned with
// `position: fixed` based on the trigger's bounding rect — so it can render
// outside any clipping ancestor and auto-flip when it would extend past the
// viewport edge. Click outside or Esc to close. Items auto-close on click.

interface MenuCtx {
  close: () => void;
}
const Ctx = createContext<MenuCtx>({ close: () => {} });

interface MenuProps {
  trigger: (props: { onClick: () => void; isOpen: boolean }) => ReactNode;
  children: ReactNode;
  align?: "left" | "right";
  /**
   * Hint to prefer opening above the trigger. The auto-positioner will still
   * override if the chosen side doesn't fit.
   */
  dropUp?: boolean;
}

const VIEWPORT_PADDING = 8;
const TRIGGER_GAP = 4;

export function Menu({ trigger, children, align = "left", dropUp = false }: MenuProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; ready: boolean }>({
    top: 0,
    left: 0,
    ready: false,
  });

  // Close on outside-click or Esc.
  useEffect(() => {
    if (!open) return;
    const onDocMouseDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Position the panel based on the trigger's rect after both are rendered.
  useLayoutEffect(() => {
    if (!open) {
      setPos((p) => (p.ready ? { ...p, ready: false } : p));
      return;
    }
    if (!triggerRef.current || !panelRef.current) return;

    const recompute = () => {
      const t = triggerRef.current?.getBoundingClientRect();
      const p = panelRef.current?.getBoundingClientRect();
      if (!t || !p) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Vertical: prefer below (or above if dropUp hinted); flip when out of room.
      const spaceBelow = vh - t.bottom - VIEWPORT_PADDING;
      const spaceAbove = t.top - VIEWPORT_PADDING;
      let top: number;
      const wantBelow = !dropUp;
      const fitsBelow = spaceBelow >= p.height;
      const fitsAbove = spaceAbove >= p.height;
      if (wantBelow && fitsBelow) {
        top = t.bottom + TRIGGER_GAP;
      } else if (!wantBelow && fitsAbove) {
        top = t.top - p.height - TRIGGER_GAP;
      } else if (fitsBelow) {
        top = t.bottom + TRIGGER_GAP;
      } else if (fitsAbove) {
        top = t.top - p.height - TRIGGER_GAP;
      } else {
        // Neither side fits — anchor to whichever has more room and clamp.
        top = spaceBelow > spaceAbove ? t.bottom + TRIGGER_GAP : VIEWPORT_PADDING;
      }
      top = Math.max(VIEWPORT_PADDING, Math.min(top, vh - p.height - VIEWPORT_PADDING));

      // Horizontal: align right means panel's right edge tracks trigger's right edge.
      let left = align === "right" ? t.right - p.width : t.left;
      left = Math.max(VIEWPORT_PADDING, Math.min(left, vw - p.width - VIEWPORT_PADDING));

      setPos({ top, left, ready: true });
    };

    recompute();
    // Re-measure on viewport changes while open.
    const onResize = () => recompute();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [open, align, dropUp]);

  return (
    <div className="relative inline-block" ref={triggerRef}>
      {trigger({ onClick: () => setOpen((o) => !o), isOpen: open })}
      {open &&
        createPortal(
          <Ctx.Provider value={{ close: () => setOpen(false) }}>
            <div
              ref={panelRef}
              role="menu"
              className="fixed z-[1000] min-w-[200px] max-w-[360px] rounded-md bg-white border border-we-border shadow-lg py-1"
              style={{
                top: pos.ready ? pos.top : -9999,
                left: pos.ready ? pos.left : -9999,
                visibility: pos.ready ? "visible" : "hidden",
              }}
            >
              {children}
            </div>
          </Ctx.Provider>,
          document.body,
        )}
    </div>
  );
}

interface MenuItemProps {
  children: ReactNode;
  onSelect?: () => void;
  icon?: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  shortcut?: string;
}

export function MenuItem({ children, onSelect, icon: Icon, danger, disabled, shortcut }: MenuItemProps) {
  const { close } = useContext(Ctx);
  return (
    <button
      role="menuitem"
      disabled={disabled}
      onClick={() => {
        if (disabled) return;
        onSelect?.();
        close();
      }}
      className={[
        "w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left",
        disabled
          ? "text-we-muted/60 cursor-not-allowed"
          : danger
          ? "text-red-600 hover:bg-red-50"
          : "text-we-ink hover:bg-slate-100",
      ].join(" ")}
    >
      {Icon ? <Icon className="w-4 h-4" /> : <span className="w-4" />}
      <span className="flex-1">{children}</span>
      {shortcut && <span className="text-[11px] text-we-muted tabular-nums">{shortcut}</span>}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1 border-t border-we-border" />;
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <div className="px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-we-muted">
      {children}
    </div>
  );
}

import { X } from "lucide-react";
import { useEffect, type ReactNode } from "react";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: string;
  /** Click on the backdrop closes the modal. Defaults to true. */
  closeOnBackdrop?: boolean;
}

// Centered modal with backdrop, Esc-to-close, and a sticky header.
export function Modal({
  open,
  onClose,
  title,
  children,
  width = "640px",
  closeOnBackdrop = true,
}: ModalProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-50 grid place-items-center bg-black/40"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-we-panel rounded-lg shadow-xl border border-we-border max-h-[85vh] flex flex-col"
        style={{ width, maxWidth: "calc(100vw - 32px)" }}
      >
        <div className="flex items-center justify-between px-5 py-3 border-b border-we-border">
          <h2 className="text-base font-medium text-we-ink">{title}</h2>
          <button
            onClick={onClose}
            className="we-btn-ghost p-1.5 rounded"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="flex-1 min-h-0 overflow-auto">{children}</div>
      </div>
    </div>
  );
}

import { CheckCircle2, Download, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useTransfers, type Transfer } from "@/state/transfers";

// Floating, bottom-right toast that shows peer-to-peer media transfers while a
// collaboration session is fetching files this peer doesn't have yet.
export function MediaSyncIndicator() {
  const transfersRecord = useTransfers((s) => s.transfers);
  const transfers = useMemo(() => Object.values(transfersRecord), [transfersRecord]);

  if (transfers.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 w-72">
      {transfers.map((t) => (
        <TransferRow key={t.hash} t={t} />
      ))}
    </div>
  );
}

function TransferRow({ t }: { t: Transfer }) {
  const pct = t.total > 0 ? Math.min(100, Math.round((t.received / t.total) * 100)) : 0;
  return (
    <div className="rounded-lg border border-we-border bg-we-panel shadow-lg px-3 py-2.5 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-sm text-we-ink min-w-0">
        {t.status === "done" ? (
          <CheckCircle2 className="w-4 h-4 text-we-teal shrink-0" />
        ) : t.status === "error" ? (
          <Download className="w-4 h-4 text-red-500 shrink-0" />
        ) : (
          <Loader2 className="w-4 h-4 text-we-teal animate-spin shrink-0" />
        )}
        <span className="truncate flex-1">{t.name || "Media"}</span>
        <span className="text-xs text-we-muted tabular-nums shrink-0">
          {t.status === "done"
            ? "done"
            : t.status === "error"
            ? "failed"
            : t.status === "verifying"
            ? "verifying"
            : t.total > 0
            ? `${pct}%`
            : "…"}
        </span>
      </div>
      {t.status !== "done" && t.status !== "error" && (
        <div className="h-1 rounded-full bg-we-border overflow-hidden">
          <div className="h-full bg-we-teal transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

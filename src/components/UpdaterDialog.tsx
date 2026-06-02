import { AlertTriangle, ArrowUpCircle, Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { checkForUpdate, type CheckResult } from "@/lib/updater";

type UiState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "up-to-date" }
  | { kind: "available"; result: Extract<CheckResult, { status: "available" }> }
  | { kind: "downloading"; downloaded: number; total?: number }
  | { kind: "installed" }
  | { kind: "error"; message: string };

interface Props {
  open: boolean;
  onClose: () => void;
  /** If true, skip the "up-to-date" message — only show UI when there IS an update. */
  silentIfUpToDate?: boolean;
}

export function UpdaterDialog({ open, onClose, silentIfUpToDate }: Props) {
  const [state, setState] = useState<UiState>({ kind: "idle" });

  const runCheck = useCallback(async () => {
    setState({ kind: "checking" });
    const result = await checkForUpdate();
    if (result.status === "up-to-date") {
      if (silentIfUpToDate) {
        onClose();
        return;
      }
      setState({ kind: "up-to-date" });
    } else if (result.status === "error") {
      if (silentIfUpToDate) {
        // Don't bother the user on a startup check
        console.warn("Updater check failed:", result.error);
        onClose();
        return;
      }
      setState({ kind: "error", message: result.error });
    } else {
      setState({ kind: "available", result });
    }
  }, [silentIfUpToDate, onClose]);

  useEffect(() => {
    if (!open) return;
    void runCheck();
  }, [open, runCheck]);

  const install = async () => {
    if (state.kind !== "available") return;
    const { result } = state;
    setState({ kind: "downloading", downloaded: 0 });
    try {
      await result.install((downloaded, total) => {
        setState({ kind: "downloading", downloaded, total });
      });
      setState({ kind: "installed" });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Updates" width="520px">
      <div className="p-5 text-sm space-y-3">
        {state.kind === "checking" && (
          <Row icon={<Loader2 className="w-4 h-4 animate-spin text-we-teal" />}>
            Checking for updates…
          </Row>
        )}

        {state.kind === "up-to-date" && (
          <Row icon={<Check className="w-4 h-4 text-emerald-600" />}>
            You're on the latest version.
          </Row>
        )}

        {state.kind === "available" && (
          <>
            <Row icon={<ArrowUpCircle className="w-4 h-4 text-we-teal" />}>
              <div className="flex-1">
                <div className="font-medium text-we-ink">
                  WeEdit {state.result.version} available
                </div>
                <div className="text-[11px] text-we-muted">
                  You're on {state.result.currentVersion}.
                </div>
              </div>
            </Row>
            {state.result.notes && (
              <details className="text-[12px] text-we-muted">
                <summary className="cursor-pointer">Release notes</summary>
                <pre className="mt-1 whitespace-pre-wrap font-sans">{state.result.notes}</pre>
              </details>
            )}
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="we-btn">Later</button>
              <button onClick={() => void install()} className="we-btn-primary">
                Download &amp; install
              </button>
            </div>
          </>
        )}

        {state.kind === "downloading" && (
          <>
            <Row icon={<Loader2 className="w-4 h-4 animate-spin text-we-teal" />}>
              Downloading {state.total
                ? `${bytesMb(state.downloaded)} / ${bytesMb(state.total)}`
                : bytesMb(state.downloaded)}
            </Row>
            <div className="h-1.5 bg-we-hover rounded overflow-hidden">
              <div
                className="h-full bg-we-teal transition-all"
                style={{
                  width: state.total ? `${(state.downloaded / state.total) * 100}%` : "30%",
                }}
              />
            </div>
            <div className="text-[11px] text-we-muted">
              The app will restart automatically when the install finishes.
            </div>
          </>
        )}

        {state.kind === "installed" && (
          <Row icon={<Check className="w-4 h-4 text-emerald-600" />}>
            Update installed. Restarting…
          </Row>
        )}

        {state.kind === "error" && (
          <>
            <Row icon={<AlertTriangle className="w-4 h-4 text-red-600" />}>
              <div className="text-red-700 leading-5">{state.message}</div>
            </Row>
            <div className="flex justify-end gap-2">
              <button onClick={onClose} className="we-btn">Close</button>
              <button onClick={() => void runCheck()} className="we-btn-primary">Retry</button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2.5">
      <div className="mt-0.5 shrink-0">{icon}</div>
      <div className="flex-1 min-w-0">{children}</div>
    </div>
  );
}

function bytesMb(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

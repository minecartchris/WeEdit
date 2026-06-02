import { Clock, GitBranch, History, RotateCcw, Save } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { normalizeClips } from "@/lib/clips";
import {
  commitVersion,
  listCommits,
  restoreVersion,
  setHead,
  type Commit,
} from "@/lib/history";
import { snapshotForFile } from "@/lib/project";
import { useEditor } from "@/state/editor";

interface Props {
  open: boolean;
  onClose: () => void;
}

// Git-like version history browser. Lists checkpoint commits newest-first and
// lets the user save a named version or restore any past one. Restoring is
// lossless — it never deletes newer commits; editing after a restore branches.
export function HistoryPanel({ open, onClose }: Props) {
  const projectPath = useEditor((s) => s.projectPath);
  const [head, setHeadState] = useState<string | null>(null);
  const [commits, setCommits] = useState<Commit[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!projectPath) {
      setCommits([]);
      setHeadState(null);
      return;
    }
    setLoading(true);
    try {
      const { head: h, commits: c } = await listCommits(projectPath);
      setHeadState(h);
      setCommits(c);
    } catch (err) {
      console.error("Failed to load history:", err);
    } finally {
      setLoading(false);
    }
  }, [projectPath]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const onSaveVersion = async () => {
    if (!projectPath) return;
    const message = window.prompt("Name this version", "Checkpoint");
    if (message == null) return;
    setBusyId("__save__");
    try {
      await commitVersion(projectPath, snapshotForFile(), message.trim() || "Checkpoint", "manual");
      await refresh();
    } catch (err) {
      console.error("Failed to save version:", err);
      window.alert("Couldn't save version. See console for details.");
    } finally {
      setBusyId(null);
    }
  };

  const onRestore = async (commit: Commit) => {
    if (!projectPath) return;
    if (
      !window.confirm(
        `Restore "${commit.message}"?\n\nYour current timeline becomes this version. Nothing is lost — newer versions stay in history and you can jump back to them.`,
      )
    )
      return;
    setBusyId(commit.id);
    try {
      const file = await restoreVersion(projectPath, commit.id);
      useEditor.getState().applyLoadedProject(
        {
          project: file.project,
          media: file.media,
          tracks: file.tracks,
          clips: normalizeClips(file.clips),
        },
        projectPath,
        file.savedAt,
      );
      await setHead(projectPath, commit.id);
      await refresh();
    } catch (err) {
      console.error("Failed to restore version:", err);
      window.alert("Couldn't restore version. See console for details.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Version history" width="560px">
      <div className="flex flex-col">
        <div className="flex items-center justify-between gap-3 px-5 py-3 border-b border-we-border">
          <p className="text-xs text-we-muted">
            {projectPath
              ? "Restore any checkpoint without losing newer ones."
              : "Save your project to disk first to start tracking versions."}
          </p>
          <button
            onClick={() => void onSaveVersion()}
            disabled={!projectPath || busyId === "__save__"}
            className="we-btn-primary text-sm shrink-0 disabled:opacity-40"
          >
            <Save className="w-3.5 h-3.5" />
            Save version
          </button>
        </div>

        {loading ? (
          <div className="px-5 py-10 text-center text-sm text-we-muted">Loading…</div>
        ) : commits.length === 0 ? (
          <div className="px-5 py-12 text-center text-we-muted flex flex-col items-center gap-2">
            <History className="w-8 h-8 opacity-40" />
            <p className="text-sm">No versions yet.</p>
            <p className="text-xs">
              Auto-save drops checkpoints periodically, or click “Save version”.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col divide-y divide-we-border max-h-[55vh] overflow-auto">
            {commits.map((commit) => {
              const isHead = commit.id === head;
              const busy = busyId === commit.id;
              return (
                <li
                  key={commit.id}
                  className={[
                    "flex items-center gap-3 px-5 py-3",
                    isHead ? "bg-we-teal/5" : "",
                  ].join(" ")}
                >
                  <div className="shrink-0 grid place-items-center w-7 h-7 rounded-full border border-we-border text-we-muted">
                    {isHead ? (
                      <GitBranch className="w-3.5 h-3.5 text-we-teal" />
                    ) : (
                      <Clock className="w-3.5 h-3.5" />
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm text-we-ink truncate">{commit.message}</span>
                      <Badge kind={commit.kind} />
                      {isHead && (
                        <span className="text-[10px] uppercase tracking-wide text-we-teal font-semibold">
                          current
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-we-muted mt-0.5">
                      {commit.author ? `${commit.author} · ` : ""}
                      {formatWhen(commit.createdAt)}
                    </div>
                  </div>
                  <button
                    onClick={() => void onRestore(commit)}
                    disabled={busy || isHead}
                    title={isHead ? "This is the current version" : "Restore this version"}
                    className="we-btn-ghost text-xs shrink-0 disabled:opacity-30"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    {busy ? "Restoring…" : "Restore"}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Modal>
  );
}

function Badge({ kind }: { kind: Commit["kind"] }) {
  const auto = kind === "auto";
  return (
    <span
      className={[
        "text-[10px] px-1.5 py-px rounded-full border",
        auto
          ? "border-we-border text-we-muted"
          : "border-we-teal/40 text-we-teal bg-we-teal/10",
      ].join(" ")}
    >
      {auto ? "auto" : "manual"}
    </span>
  );
}

function formatWhen(t: number): string {
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return "just now";
  const min = sec / 60;
  if (min < 60) return `${Math.floor(min)} min ago`;
  const h = min / 60;
  if (h < 24) return `${Math.floor(h)} h ago`;
  return new Date(t).toLocaleString();
}

import { useMemo } from "react";
import { useCollab } from "@/state/collab";

// Live presence overlay drawn inside the timeline's track-rows container, using
// the same coordinate model as PlayheadOverlay (left = 160px header + sec*px).
// One colored playhead line + name pill per remote collaborator.
//
// `peers` is a stable Record in the collab store; we derive a memoized array
// here rather than returning a fresh array from the selector (that would break
// useSyncExternalStore under StrictMode).
export function CollaboratorCursors({ pxPerSec }: { pxPerSec: number }) {
  const peersRecord = useCollab((s) => s.peers);
  const status = useCollab((s) => s.status);
  const peers = useMemo(() => Object.values(peersRecord), [peersRecord]);

  if (status !== "connected" || peers.length === 0) return null;

  return (
    <>
      {peers.map((p) => (
        <div
          key={p.clientId}
          className="absolute top-0 bottom-0 pointer-events-none z-20"
          style={{ left: 160 + p.playheadSec * pxPerSec }}
        >
          <div className="absolute top-0 bottom-0 w-px" style={{ backgroundColor: p.color }} />
          <div
            className="absolute top-0 -translate-x-px whitespace-nowrap rounded-br px-1 py-px text-[10px] font-medium text-white shadow"
            style={{ backgroundColor: p.color }}
          >
            {p.name}
          </div>
        </div>
      ))}
    </>
  );
}

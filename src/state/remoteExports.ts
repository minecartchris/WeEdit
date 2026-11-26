import { create } from "zustand";

// "Export on the host" for collaborators who can't export themselves (the
// browser editor has no ffmpeg). The requests live in the session doc
// (lib/collab/remoteExport.ts); this store is what the UI reads, and stays
// free of yjs like the other collab stores.

export interface RemoteExportOptions {
  width: number;
  height: number;
  fps: number;
  cq: number;
  audioBitrateKbps: number;
  reframe?: "fit" | "fill";
  reframeFocus?: number;
  label: string;
}

export type RemoteExportStatus = "requested" | "exporting" | "done" | "declined" | "failed";

export interface RemoteExportRequest {
  id: string;
  fromPid: string;
  fromName: string;
  opts: RemoteExportOptions;
  status: RemoteExportStatus;
  /** 0..1 while the host is rendering. */
  progress?: number;
  error?: string;
  /** Set when done: the file the requester downloads over the session. */
  hash?: string;
  size?: number;
  fileName?: string;
  at: number;
}

interface RemoteExportsState {
  /** Every request in the session (the host acts on these). */
  requests: RemoteExportRequest[];
  /** Requester side: what happened to my latest request locally. */
  mine: { id: string; phase: "waiting" | "downloading" | "saved" | "failed"; error?: string } | null;
  /** Wired by the active session; no-ops otherwise. */
  request: (opts: RemoteExportOptions) => void;
  accept: (id: string) => void;
  decline: (id: string) => void;
  dismissMine: () => void;
}

export const useRemoteExports = create<RemoteExportsState>((set) => ({
  requests: [],
  mine: null,
  request: () => {},
  accept: () => {},
  decline: () => {},
  dismissMine: () => set({ mine: null }),
}));

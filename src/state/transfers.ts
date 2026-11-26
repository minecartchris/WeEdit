import { create } from "zustand";

// Lightweight store for peer-to-peer media transfer progress. Kept separate from
// the heavy mediaSync module (which pulls in y-webrtc) so the progress toast can
// subscribe without loading the WebRTC stack — the collab subsystem only loads
// when a session actually starts.

/** "proxy" = the small editing copy sent first; "full" = the original file. */
export type TransferVariant = "proxy" | "full";

export interface Transfer {
  /** Row key (content hash + variant), not just the hash: a file can have both in flight. */
  hash: string;
  name: string;
  variant: TransferVariant;
  /** "down" = we're receiving it; "up" = we're sending it to a collaborator. */
  direction: "down" | "up";
  /** Up only: the collaborator's display name, if they've set one. */
  peer?: string;
  received: number; // bytes written so far (up: bytes sent so far)
  total: number;    // total bytes (0 if unknown)
  rate: number;     // bytes/sec, sampled over the last ~0.5s (0 if unknown)
  /** "preparing" = the holder is still encoding the proxy. */
  status: "preparing" | "fetching" | "verifying" | "done" | "error";
  /** 0..1 progress of the holder's proxy encode, while preparing. */
  prepPercent?: number;
}

interface TransfersState {
  transfers: Record<string, Transfer>;
  /** Files waiting their turn behind the active download. */
  queued: number;
  /** Originals downloaded this session, and how many there are in all ("2 / 15"). */
  filesDone: number;
  filesTotal: number;
}

export const useTransfers = create<TransfersState>(() => ({ transfers: {}, queued: 0, filesDone: 0, filesTotal: 0 }));

export function setFilesProgress(filesDone: number, filesTotal: number): void {
  const s = useTransfers.getState();
  if (s.filesDone !== filesDone || s.filesTotal !== filesTotal) useTransfers.setState({ filesDone, filesTotal });
}

export function setQueued(queued: number): void {
  if (useTransfers.getState().queued !== queued) useTransfers.setState({ queued });
}

export function setTransfer(hash: string, patch: Partial<Transfer> & { name?: string }): void {
  useTransfers.setState((s) => {
    const prev =
      s.transfers[hash] ??
      { hash, name: "", variant: "full" as const, direction: "down" as const, received: 0, total: 0, rate: 0, status: "fetching" as const };
    return { transfers: { ...s.transfers, [hash]: { ...prev, ...patch } } };
  });
}

export function clearTransfer(hash: string): void {
  useTransfers.setState((s) => {
    const next = { ...s.transfers };
    delete next[hash];
    return { transfers: next };
  });
}

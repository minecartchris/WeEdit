import { create } from "zustand";

// Lightweight store for peer-to-peer media transfer progress. Kept separate from
// the heavy mediaSync module (which pulls in y-webrtc) so the progress toast can
// subscribe without loading the WebRTC stack — the collab subsystem only loads
// when a session actually starts.

export interface Transfer {
  hash: string;
  name: string;
  received: number; // bytes written so far
  total: number;    // total bytes (0 if unknown)
  status: "fetching" | "verifying" | "done" | "error";
}

interface TransfersState {
  transfers: Record<string, Transfer>;
}

export const useTransfers = create<TransfersState>(() => ({ transfers: {} }));

export function setTransfer(hash: string, patch: Partial<Transfer> & { name?: string }): void {
  useTransfers.setState((s) => {
    const prev =
      s.transfers[hash] ?? { hash, name: "", received: 0, total: 0, status: "fetching" as const };
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

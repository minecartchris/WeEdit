import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { WebrtcProvider } from "y-webrtc";
import * as Y from "yjs";
import { webrtcProviderOptions } from "@/lib/collab/config";
import { useEditor } from "@/state/editor";
import { clearTransfer, setTransfer, useTransfers } from "@/state/transfers";
import type { MediaItem } from "@/types";

// Peer-to-peer media transfer for collaboration.
//
// The project doc (collabDoc) carries media *identity* (contentHash) but never a
// peer's local file path. This module makes the bytes available so previews
// render everywhere: each peer hashes the files it has and advertises them, and
// fetches any file it lacks from a holder over a dedicated, throwaway y-webrtc
// "files" room — chunked, windowed, cached, and verified.
//
// ⚠️ Honest scope: this works peer-to-peer with no port forwarding, but a
// multi-GB VOD over public-signaling WebRTC is slow. It's lazy (only fetches
// files you actually need), cached on disk, and a shared NAS remains the fast
// path. Use it for clips and modest assets; expect patience on huge sources.

const CHUNK_SIZE = 64 * 1024;        // bytes per chunk
const SERVE_WINDOW = 24;             // max outstanding (unconsumed) chunks in flight

interface RequestRec {
  hash: string;
  ext: string;
  size: number;
  requester: number;
  servedBy: number;
}

// ── Active-session handles ───────────────────────────────────────────────────
let filesDoc: Y.Doc | null = null;
let filesProvider: WebrtcProvider | null = null;
let mainAwareness: WebrtcProvider["awareness"] | null = null;
let clientId = 0;
let cacheDir = "";

let requests: Y.Map<unknown> | null = null;
let metaMap: Y.Map<unknown> | null = null;
let chunks: Y.Map<unknown> | null = null;

let unsubStore: (() => void) | null = null;
let hashTimer: number | null = null;

const served = new Set<string>();                 // requestIds we're serving
const fetches = new Map<string, FetchState>();    // hash → in-progress fetch

interface FetchState {
  requestId: string;
  mediaId: string;
  partPath: string;
  finalPath: string;
  expected: number;  // next chunk seq to append
  draining: boolean;
}

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const extOf = (src: string) => (src.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");

export async function startMediaSync(roomId: string, mainProvider: WebrtcProvider): Promise<void> {
  await stopMediaSync();
  mainAwareness = mainProvider.awareness;
  clientId = mainAwareness.clientID;
  const base = (await appLocalDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  cacheDir = `${base}/collab-media`;

  filesDoc = new Y.Doc();
  filesProvider = new WebrtcProvider(`weedit-files-${roomId}`, filesDoc, webrtcProviderOptions());
  requests = filesDoc.getMap("requests");
  metaMap = filesDoc.getMap("meta");
  chunks = filesDoc.getMap("chunks");

  requests.observe(onRequests);
  chunks.observe(onChunks);
  metaMap.observe(onChunks);
  mainAwareness.on("change", scheduleScan);

  // React to media list changes (new imports to hash, new gaps to fetch).
  unsubStore = useEditor.subscribe((s, prev) => {
    if (s.media !== prev.media) scheduleScan();
  });

  scheduleScan();
}

export async function stopMediaSync(): Promise<void> {
  if (hashTimer != null) {
    clearTimeout(hashTimer);
    hashTimer = null;
  }
  unsubStore?.();
  unsubStore = null;
  if (mainAwareness) mainAwareness.off("change", scheduleScan);
  try {
    filesProvider?.destroy();
    filesDoc?.destroy();
  } catch (err) {
    console.error("Error tearing down media sync:", err);
  }
  filesProvider = null;
  filesDoc = null;
  requests = metaMap = chunks = null;
  mainAwareness = null;
  served.clear();
  fetches.clear();
  useTransfers.setState({ transfers: {} });
}

// Debounce hashing + fetch scanning so a burst of store updates collapses.
function scheduleScan(): void {
  if (hashTimer != null) return;
  hashTimer = window.setTimeout(() => {
    hashTimer = null;
    void refreshLocalHashes().then(maybeFetchMissing);
  }, 300);
}

// Hash the files we hold (so peers can identify + request them) and advertise
// the set of hashes we can serve via the main awareness `have` field.
async function refreshLocalHashes(): Promise<void> {
  const media = useEditor.getState().media;
  const have: string[] = [];
  for (const m of media) {
    if (!m.src) continue;
    let exists = false;
    try {
      exists = await invoke<boolean>("path_exists", { path: m.src });
    } catch {
      exists = false;
    }
    if (!exists) continue;
    let hash = m.contentHash;
    if (!hash || m.size == null || !m.ext) {
      try {
        hash = await invoke<string>("hash_file", { path: m.src });
        const size = await invoke<number>("file_size", { path: m.src });
        updateMediaLocal(m.id, { contentHash: hash, size, ext: extOf(m.src) });
      } catch (err) {
        console.error("hash_file failed for", m.src, err);
        continue;
      }
    }
    if (hash) have.push(hash);
  }
  mainAwareness?.setLocalStateField("have", have);
}

function updateMediaLocal(id: string, patch: Partial<MediaItem>): void {
  useEditor.setState((s) => ({
    media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}

function findHolder(hash: string): number | null {
  if (!mainAwareness) return null;
  let holder: number | null = null;
  mainAwareness.getStates().forEach((state, id) => {
    if (id === clientId || holder != null) return;
    const have = (state as { have?: string[] }).have;
    if (Array.isArray(have) && have.includes(hash)) holder = id;
  });
  return holder;
}

// For each media we don't have bytes for, resolve from cache or fetch from a peer.
async function maybeFetchMissing(): Promise<void> {
  if (!requests) return;
  for (const m of useEditor.getState().media) {
    if (m.src) continue;                       // already resolved locally
    if (!m.contentHash || !m.ext) continue;    // not yet identified
    if (fetches.has(m.contentHash)) continue;  // in progress

    const finalPath = `${cacheDir}/${m.contentHash}.${m.ext}`;
    let cached = false;
    try {
      cached = await invoke<boolean>("path_exists", { path: finalPath });
    } catch {
      cached = false;
    }
    if (cached) {
      setMediaSrcLocal(m.id, finalPath);
      continue;
    }

    const holder = findHolder(m.contentHash);
    if (holder == null) continue; // nobody advertises it yet — retry on next scan
    void beginFetch(m, holder, finalPath);
  }
}

function setMediaSrcLocal(id: string, path: string): void {
  // src is per-peer local and stripped by the reconciler, so this never syncs.
  updateMediaLocal(id, { src: path });
}

async function beginFetch(m: MediaItem, holder: number, finalPath: string): Promise<void> {
  if (!requests || !m.contentHash || !m.ext) return;
  const requestId = crypto.randomUUID();
  const partPath = `${finalPath}.part`;
  const state: FetchState = {
    requestId,
    mediaId: m.id,
    partPath,
    finalPath,
    expected: 0,
    draining: false,
  };
  fetches.set(m.contentHash, state);
  setTransfer(m.contentHash, { name: m.name, total: m.size ?? 0, received: 0, status: "fetching" });

  try {
    await invoke("remove_file", { path: partPath }); // clear any stale partial
  } catch (err) {
    console.error("Couldn't clear partial:", err);
  }

  const req: RequestRec = {
    hash: m.contentHash,
    ext: m.ext,
    size: m.size ?? 0,
    requester: clientId,
    servedBy: holder,
  };
  requests.set(requestId, req);
}

// ── Serving (we hold the file) ───────────────────────────────────────────────
function onRequests(): void {
  if (!requests) return;
  requests.forEach((value, requestId) => {
    const r = value as RequestRec;
    if (r.servedBy !== clientId || served.has(requestId)) return;
    const local = useEditor.getState().media.find((m) => m.contentHash === r.hash && m.src);
    if (!local) return;
    served.add(requestId);
    void serveFile(requestId, local.src, r);
  });
}

function outstanding(requestId: string): number {
  if (!chunks) return 0;
  let n = 0;
  for (const key of chunks.keys()) if (key.startsWith(`${requestId}:`)) n++;
  return n;
}

async function serveFile(requestId: string, path: string, r: RequestRec): Promise<void> {
  if (!chunks || !metaMap) return;
  try {
    const size = r.size > 0 ? r.size : await invoke<number>("file_size", { path });
    const total = Math.max(1, Math.ceil(size / CHUNK_SIZE));
    metaMap.set(requestId, { totalChunks: total, size });

    let offset = 0;
    for (let seq = 0; seq < total; seq++) {
      // Windowed flow control: wait for the receiver to drain consumed chunks.
      while (outstanding(requestId) >= SERVE_WINDOW) {
        if (!requests?.has(requestId)) {
          served.delete(requestId);
          return; // requester gave up / left
        }
        await delay(60);
      }
      const b64 = await invoke<string>("read_file_chunk", {
        path,
        offset,
        length: CHUNK_SIZE,
      });
      chunks.set(`${requestId}:${seq}`, b64);
      offset += CHUNK_SIZE;
    }
  } catch (err) {
    console.error("serveFile failed:", err);
    served.delete(requestId);
  }
}

// ── Receiving (we requested the file) ────────────────────────────────────────
function onChunks(): void {
  for (const [hash, f] of fetches) void drain(hash, f);
}

async function drain(hash: string, f: FetchState): Promise<void> {
  if (!chunks || !metaMap || f.draining) return;
  const meta = metaMap.get(f.requestId) as { totalChunks: number; size: number } | undefined;
  if (!meta) return;

  f.draining = true;
  try {
    while (true) {
      const key = `${f.requestId}:${f.expected}`;
      const b64 = chunks.get(key) as string | undefined;
      if (b64 === undefined) break; // next contiguous chunk not here yet

      await invoke("append_file_chunk", { path: f.partPath, dataBase64: b64 });
      chunks.delete(key); // free it so the sender's window advances
      f.expected += 1;
      const received = Math.min(meta.size, f.expected * CHUNK_SIZE);
      setTransfer(hash, { received, total: meta.size });

      if (f.expected >= meta.totalChunks) {
        await finishFetch(hash, f);
        return;
      }
    }
  } catch (err) {
    console.error("drain failed:", err);
    setTransfer(hash, { status: "error" });
    fetches.delete(hash);
  } finally {
    f.draining = false;
  }
}

async function finishFetch(hash: string, f: FetchState): Promise<void> {
  setTransfer(hash, { status: "verifying" });
  try {
    const got = await invoke<string>("hash_file", { path: f.partPath });
    if (got !== hash) {
      console.error("Hash mismatch for fetched media; discarding.");
      await invoke("remove_file", { path: f.partPath });
      setTransfer(hash, { status: "error" });
      fetches.delete(hash);
      cleanupRequest(f.requestId);
      return;
    }
    await invoke("rename_path", { from: f.partPath, to: f.finalPath });
    setMediaSrcLocal(f.mediaId, f.finalPath);
    setTransfer(hash, { status: "done" });
    setTimeout(() => clearTransfer(hash), 2500);
  } catch (err) {
    console.error("finishFetch failed:", err);
    setTransfer(hash, { status: "error" });
  } finally {
    fetches.delete(hash);
    cleanupRequest(f.requestId);
  }
}

function cleanupRequest(requestId: string): void {
  if (!requests || !metaMap || !chunks) return;
  filesDoc?.transact(() => {
    requests!.delete(requestId);
    metaMap!.delete(requestId);
    for (const key of [...chunks!.keys()]) if (key.startsWith(`${requestId}:`)) chunks!.delete(key);
  });
}

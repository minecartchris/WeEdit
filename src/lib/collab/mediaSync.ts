import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import { WebrtcProvider } from "y-webrtc";
import { createMediaChannels, dataFrame, type MediaChannel } from "@/lib/collab/mediaChannel";
import { useEditor } from "@/state/editor";
import { clearTransfer, setTransfer, useTransfers } from "@/state/transfers";
import type { MediaItem } from "@/types";

// Peer-to-peer media transfer for collaboration.
//
// The project doc (collabDoc) carries media *identity* (contentHash) but never a
// peer's local file path. This module makes the bytes available so previews
// render everywhere: each peer hashes the files it has and advertises them over
// awareness, and fetches any file it lacks from a holder — streamed, verified
// and cached on disk.
//
// TRANSPORT: bytes go over a dedicated RTCDataChannel per peer (mediaChannel),
// not through the Yjs document. The old design wrote base64 chunks into a shared
// Y.Map, which meant one CRDT operation per 16 KiB — encoded, broadcast to every
// peer in the room, and retained in the doc's history — plus a Tauri IPC call
// per chunk and a 24-chunk window polled on a 60 ms timer. That capped
// throughput at a few hundred KB/s no matter how fast the link was, which is why
// multi-GB sources took hours. Now a block moves once, to one peer, as raw
// bytes, with the channel's own back-pressure as flow control.
//
// Still true: a shared NAS beats any WAN transfer, and the fetch is lazy (only
// files you actually need) and cached on disk, so a rejoin costs nothing.

/** File bytes per disk read / IPC call / compression unit. */
const BLOCK_BYTES = 4 * 1024 * 1024;
/** Bytes per data-channel message. 64 KiB sits safely under the SCTP ceiling. */
const FRAME_BYTES = 64 * 1024;
/** Pause sending once this much is queued in the channel... */
const SEND_HIGH_WATER = 4 * 1024 * 1024;
/** ...and resume once it drains below this. */
const SEND_LOW_WATER = 1 * 1024 * 1024;
/** How long to wait for a `want` to be answered before trying another holder. */
const OFFER_TIMEOUT_MS = 20_000;
/** Give up on a transfer that hasn't written a byte for this long. */
const STALL_TIMEOUT_MS = 60_000;
/** After a failure, don't re-request the same file for this long. */
const RETRY_COOLDOWN_MS = 15_000;
/** Watchdog tick. */
const WATCHDOG_MS = 10_000;

// Diagnostic logging for the P2P media transfer. Visible in DevTools on both
// peers so a stalled transfer can be traced (discovery vs request vs blocks).
const log = (...args: unknown[]) => console.log("[mediaSync]", ...args);

// ── Active-session handles ───────────────────────────────────────────────────
let channels: ReturnType<typeof createMediaChannels> | null = null;
let mainAwareness: WebrtcProvider["awareness"] | null = null;
let clientId = 0;
let cacheDir = "";

let unsubStore: (() => void) | null = null;
let scanTimer: number | null = null;
let scanWantsHashes = false;
let watchdog: number | null = null;

/** contentHash -> timestamp before which we won't re-request it after a failure. */
const cooldowns = new Map<string, number>();

/** Transfers we're receiving, keyed by content hash. */
const fetches = new Map<string, FetchState>();
/** Transfers we're sending, keyed by `${peerId}:${transferId}`. */
const sends = new Map<string, SendState>();

interface FetchState {
  transferId: number;
  hash: string;
  ext: string;
  mediaId: string;
  name: string;
  partPath: string;
  finalPath: string;
  /** Bytes confirmed written to the .part file. */
  written: number;
  /** Total file size, as offered by the holder. */
  size: number;
  /** Frames of the in-flight block, awaiting the rest of it. */
  pending: Uint8Array[];
  pendingBytes: number;
  /** Encoded length of the block currently arriving (null between blocks). */
  blockBytes: number | null;
  /** Serialises the append IPC calls so blocks land in order. */
  writeChain: Promise<void>;
  offerTimer: number | null;
  /** Holders we've already asked that couldn't serve it. */
  tried: Set<number>;
  /** y-webrtc peerId currently serving us, so a peer leaving fails it fast. */
  servingPeerId: string | null;
  /** performance.now() of the last byte written, for the stall watchdog. */
  progressAt: number;
  rateAt: number;
  rateBytes: number;
  done: boolean;
}

interface SendState {
  cancelled: boolean;
}

const extOf = (src: string) => (src.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");

/** Paths cross the IPC header as URL-safe base64 to survive non-ASCII names. */
function encodePathHeader(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function startMediaSync(roomId: string, mainProvider: WebrtcProvider): Promise<void> {
  await stopMediaSync();
  mainAwareness = mainProvider.awareness;
  clientId = mainAwareness.clientID;
  const base = (await appLocalDataDir()).replace(/\\/g, "/").replace(/\/$/, "");
  cacheDir = `${base}/collab-media`;

  channels = createMediaChannels(mainProvider, {
    clientId,
    onControl: handleControl,
    onData: handleData,
    onOpen: () => scheduleScan(), // a new peer may hold something we need
    onClose: (chan) => dropPeer(chan.peerId),
    log,
  });

  // Awareness changes constantly (every peer's playhead), so these scans only
  // look for new gaps to fill; re-hashing our own files is driven by the media
  // list instead, which is the only thing that can change what we hold.
  mainAwareness.on("change", scheduleScan);
  log("started for room", roomId, "clientId", clientId, "cache", cacheDir);

  unsubStore = useEditor.subscribe((s, prev) => {
    if (s.media !== prev.media) scheduleScan(true);
  });

  watchdog = window.setInterval(checkForStalls, WATCHDOG_MS);
  scheduleScan(true);
}

/**
 * Fail transfers that have gone quiet. Without this a sender that dies without
 * closing its channel leaves the receiver showing "fetching" forever.
 */
function checkForStalls(): void {
  const now = performance.now();
  for (const f of [...fetches.values()]) {
    if (f.done) continue;
    if (now - f.progressAt > STALL_TIMEOUT_MS) failFetch(f, "stalled");
  }
}

export async function stopMediaSync(): Promise<void> {
  if (scanTimer != null) {
    clearTimeout(scanTimer);
    scanTimer = null;
  }
  if (watchdog != null) {
    clearInterval(watchdog);
    watchdog = null;
  }
  unsubStore?.();
  unsubStore = null;
  cooldowns.clear();
  if (mainAwareness) mainAwareness.off("change", scheduleScan);
  for (const f of fetches.values()) {
    f.done = true;
    if (f.offerTimer != null) clearTimeout(f.offerTimer);
  }
  for (const s of sends.values()) s.cancelled = true;
  try {
    channels?.stop();
  } catch (err) {
    console.error("Error tearing down media sync:", err);
  }
  channels = null;
  mainAwareness = null;
  fetches.clear();
  sends.clear();
  useTransfers.setState({ transfers: {} });
}

/** A peer went away: stop whatever was in flight with it, either direction. */
function dropPeer(peerId: string): void {
  for (const [key, state] of sends) {
    if (key.startsWith(`${peerId}:`)) state.cancelled = true;
  }
  for (const f of [...fetches.values()]) {
    if (f.servingPeerId === peerId && !f.done) failFetch(f, "holder disconnected");
  }
  scheduleScan(); // what it was sending us may be available elsewhere
}

/**
 * Debounce scanning so a burst of updates collapses into one pass. `withHashes`
 * also re-hashes the files we hold — only worth doing when the media list
 * changed, since the awareness-driven calls fire on every peer playhead move.
 */
function scheduleScan(withHashes = false): void {
  scanWantsHashes = scanWantsHashes || withHashes;
  if (scanTimer != null) return;
  scanTimer = window.setTimeout(() => {
    scanTimer = null;
    const full = scanWantsHashes;
    scanWantsHashes = false;
    const pass = full ? refreshLocalHashes() : Promise.resolve();
    void pass.then(maybeFetchMissing);
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
  log("refreshLocalHashes: advertising have =", have);
}

function updateMediaLocal(id: string, patch: Partial<MediaItem>): void {
  useEditor.setState((s) => ({
    media: s.media.map((m) => (m.id === id ? { ...m, ...patch } : m)),
  }));
}

/** clientIds advertising `hash` that we have an open channel to, minus `skip`. */
function holdersOf(hash: string, skip: Set<number>): number[] {
  const open = channels;
  if (!mainAwareness || !open) return [];
  const out: number[] = [];
  mainAwareness.getStates().forEach((state, id) => {
    if (id === clientId || skip.has(id)) return;
    const have = (state as { have?: string[] }).have;
    if (Array.isArray(have) && have.includes(hash) && open.byClientId(id)) out.push(id);
  });
  return out;
}

// For each media we don't have bytes for, resolve from cache or fetch from a peer.
async function maybeFetchMissing(): Promise<void> {
  for (const m of useEditor.getState().media) {
    if (m.src) continue;                       // already resolved locally
    if (!m.contentHash || !m.ext) continue;    // not yet identified
    if (fetches.has(m.contentHash)) continue;  // in progress
    const until = cooldowns.get(m.contentHash);
    if (until != null && Date.now() < until) continue; // recently failed

    const finalPath = `${cacheDir}/${m.contentHash}.${m.ext}`;
    let cached = false;
    try {
      cached = await invoke<boolean>("path_exists", { path: finalPath });
    } catch {
      cached = false;
    }
    if (cached) {
      log("resolved", m.name, "from local cache");
      setMediaSrcLocal(m.id, finalPath);
      continue;
    }

    const holders = holdersOf(m.contentHash, new Set());
    log("need", m.name, "hash", m.contentHash.slice(0, 8), "holders", holders);
    if (holders.length === 0) continue; // nobody reachable has it — retry next scan
    void beginFetch(m, finalPath);
  }
}

function setMediaSrcLocal(id: string, path: string): void {
  // src is per-peer local and stripped by the reconciler, so this never syncs.
  updateMediaLocal(id, { src: path });
}

// ── Receiving ────────────────────────────────────────────────────────────────

async function beginFetch(m: MediaItem, finalPath: string): Promise<void> {
  const hash = m.contentHash;
  if (!hash || !m.ext || fetches.has(hash)) return;

  const f: FetchState = {
    transferId: (crypto.getRandomValues(new Uint32Array(1))[0] || 1) >>> 0,
    hash,
    ext: m.ext,
    mediaId: m.id,
    name: m.name,
    partPath: `${finalPath}.part`,
    finalPath,
    written: 0,
    size: m.size ?? 0,
    pending: [],
    pendingBytes: 0,
    blockBytes: null,
    writeChain: Promise.resolve(),
    offerTimer: null,
    tried: new Set(),
    servingPeerId: null,
    progressAt: performance.now(),
    rateAt: performance.now(),
    rateBytes: 0,
    done: false,
  };
  fetches.set(hash, f);
  setTransfer(hash, { name: m.name, total: f.size, received: 0, status: "fetching" });

  try {
    await invoke("remove_file", { path: f.partPath }); // clear any stale partial
  } catch (err) {
    console.error("Couldn't clear partial:", err);
  }

  askNextHolder(f);
}

/** Send `want` to the next holder that hasn't already declined. */
function askNextHolder(f: FetchState): void {
  if (f.done) return;
  const holder = holdersOf(f.hash, f.tried)[0];
  if (holder == null) {
    failFetch(f, "no reachable holder");
    return;
  }
  f.tried.add(holder);
  const chan = channels?.byClientId(holder);
  if (!chan) {
    askNextHolder(f);
    return;
  }
  chan.sendControl({ t: "want", id: f.transferId, hash: f.hash, ext: f.ext });
  log("asked peer", holder, "for", f.name, "transfer", f.transferId);

  if (f.offerTimer != null) clearTimeout(f.offerTimer);
  f.offerTimer = window.setTimeout(() => {
    f.offerTimer = null;
    if (f.done || f.written > 0) return;
    log("no offer for", f.name, "from peer", holder, "— trying another holder");
    askNextHolder(f);
  }, OFFER_TIMEOUT_MS);
}

function failFetch(f: FetchState, why: string): void {
  log("fetch failed for", f.name, "—", why);
  f.done = true;
  cooldowns.set(f.hash, Date.now() + RETRY_COOLDOWN_MS);
  if (f.offerTimer != null) clearTimeout(f.offerTimer);
  setTransfer(f.hash, { status: "error", rate: 0 });
  fetches.delete(f.hash);
  // Leave the row up briefly so the failure is visible, then let the next scan
  // try again — a holder may come back online.
  setTimeout(() => clearTransfer(f.hash), 6000);
}

function fetchById(transferId: number): FetchState | null {
  for (const f of fetches.values()) if (f.transferId === transferId) return f;
  return null;
}

function handleControl(chan: MediaChannel, msg: Record<string, unknown>): void {
  switch (msg.t) {
    case "want":
      void serve(chan, msg);
      return;
    case "offer": {
      const f = fetchById(Number(msg.id));
      if (!f) return;
      if (f.offerTimer != null) {
        clearTimeout(f.offerTimer);
        f.offerTimer = null;
      }
      f.size = Number(msg.size) || f.size;
      f.servingPeerId = chan.peerId;
      f.progressAt = performance.now();
      setTransfer(f.hash, { total: f.size });
      log("offer accepted for", f.name, "size", f.size);
      return;
    }
    case "deny": {
      const f = fetchById(Number(msg.id));
      if (!f) return;
      log("peer declined", f.name, "—", msg.reason);
      askNextHolder(f);
      return;
    }
    case "block": {
      const f = fetchById(Number(msg.id));
      if (!f) return;
      f.blockBytes = Number(msg.encLen);
      f.pending = [];
      f.pendingBytes = 0;
      return;
    }
    case "end": {
      const f = fetchById(Number(msg.id));
      if (!f) return;
      if (msg.error) {
        failFetch(f, String(msg.error));
        return;
      }
      // The last block's write may still be queued; finalize behind it.
      f.writeChain = f.writeChain
        .then(() => finishFetch(f))
        .catch((err) => {
          console.error("[mediaSync] finalize failed:", err);
          failFetch(f, "finalize failed");
        });
      return;
    }
    case "cancel": {
      const s = sends.get(`${chan.peerId}:${Number(msg.id)}`);
      if (s) s.cancelled = true;
      return;
    }
  }
}

function handleData(_chan: MediaChannel, transferId: number, payload: Uint8Array): void {
  const f = fetchById(transferId);
  if (!f || f.done || f.blockBytes == null) return;

  // Copy out of the frame: `payload` is a subarray view over the message's
  // buffer, and holding views would pin a whole block's worth of frame buffers.
  f.pending.push(new Uint8Array(payload));
  f.pendingBytes += payload.byteLength;
  if (f.pendingBytes < f.blockBytes) return;

  // Whole block in hand — hand it to Rust to inflate (if needed) and append.
  const block = new Uint8Array(f.pendingBytes);
  let at = 0;
  for (const part of f.pending) {
    block.set(part, at);
    at += part.byteLength;
  }
  f.pending = [];
  f.pendingBytes = 0;
  f.blockBytes = null;

  f.writeChain = f.writeChain
    .then(async () => {
      if (f.done) return;
      const wrote = await invoke<number>("append_media_block", block.buffer as ArrayBuffer, {
        headers: { "x-weedit-path": encodePathHeader(f.partPath) },
      });
      f.written += wrote;
      f.progressAt = performance.now();
      reportProgress(f);
    })
    .catch((err) => {
      console.error("[mediaSync] append_media_block failed:", err);
      failFetch(f, "write failed");
    });
}

function reportProgress(f: FetchState): void {
  const now = performance.now();
  const dt = now - f.rateAt;
  // Throttle the rate sample so the toast shows a steady number rather than
  // per-block noise (and so the store isn't written on every single block).
  if (dt >= 500) {
    const rate = ((f.written - f.rateBytes) * 1000) / dt;
    f.rateAt = now;
    f.rateBytes = f.written;
    setTransfer(f.hash, { received: f.written, total: f.size, rate });
  } else {
    setTransfer(f.hash, { received: f.written, total: f.size });
  }
}

async function finishFetch(f: FetchState): Promise<void> {
  if (f.done) return;
  f.done = true;
  setTransfer(f.hash, { status: "verifying", received: f.written, rate: 0 });
  try {
    const got = await invoke<string>("hash_file", { path: f.partPath });
    if (got !== f.hash) {
      console.error("Hash mismatch for fetched media; discarding.");
      await invoke("remove_file", { path: f.partPath });
      setTransfer(f.hash, { status: "error" });
      setTimeout(() => clearTransfer(f.hash), 6000);
      return;
    }
    await invoke("rename_path", { from: f.partPath, to: f.finalPath });
    cooldowns.delete(f.hash);
    setMediaSrcLocal(f.mediaId, f.finalPath);
    setTransfer(f.hash, { status: "done" });
    log("fetch complete:", f.finalPath);
    setTimeout(() => clearTransfer(f.hash), 2500);
  } catch (err) {
    console.error("finishFetch failed:", err);
    setTransfer(f.hash, { status: "error" });
  } finally {
    fetches.delete(f.hash);
  }
}

// ── Serving (we hold the file) ───────────────────────────────────────────────

async function serve(chan: MediaChannel, msg: Record<string, unknown>): Promise<void> {
  const transferId = Number(msg.id);
  const hash = String(msg.hash);
  const key = `${chan.peerId}:${transferId}`;
  if (sends.has(key)) return;

  const local = useEditor.getState().media.find((m) => m.contentHash === hash && m.src);
  if (!local?.src) {
    log("got a request for", hash.slice(0, 8), "but I don't hold that file");
    chan.sendControl({ t: "deny", id: transferId, reason: "not held" });
    return;
  }

  const state: SendState = { cancelled: false };
  sends.set(key, state);
  try {
    const size = local.size ?? (await invoke<number>("file_size", { path: local.src }));
    chan.sendControl({ t: "offer", id: transferId, size });
    log("serving", local.name, size, "bytes to", chan.peerId.slice(0, 8));

    // Compression is decided per file from its first block: deflate buys a lot
    // on WAV / image sequences / subtitles and nothing at all on h264/h265, and
    // the sender pays the CPU either way. Probe once, then stick with it.
    let compress: boolean = true;
    let probed = false;

    for (let offset = 0; offset < size; offset += BLOCK_BYTES) {
      if (state.cancelled || chan.channel.readyState !== "open") {
        log("send cancelled for", local.name);
        return;
      }
      const raw: ArrayBuffer = await invoke<ArrayBuffer>("read_media_block", {
        path: local.src,
        offset,
        length: Math.min(BLOCK_BYTES, size - offset),
        compress,
      });
      const block: Uint8Array<ArrayBuffer> = new Uint8Array(raw);
      if (block.byteLength <= 1) break; // EOF (the file shrank under us)

      if (!probed) {
        probed = true;
        // block[0] is the codec, and the backend only returns the compressed
        // form when the block actually shrank — so a stored first block is the
        // signal that this file isn't worth compressing.
        compress = block[0] === 1;
        log(compress ? "compressing" : "sending stored:", local.name);
      }

      chan.sendControl({ t: "block", id: transferId, encLen: block.byteLength });
      for (let at = 0; at < block.byteLength; at += FRAME_BYTES) {
        if (state.cancelled || chan.channel.readyState !== "open") return;
        await waitForDrain(chan.channel);
        chan.channel.send(dataFrame(transferId, block.subarray(at, at + FRAME_BYTES)));
      }
    }

    if (!state.cancelled && chan.channel.readyState === "open") {
      chan.sendControl({ t: "end", id: transferId });
      log("sent all of", local.name);
    }
  } catch (err) {
    console.error("[mediaSync] serve failed:", err);
    if (chan.channel.readyState === "open") {
      chan.sendControl({ t: "end", id: transferId, error: String(err) });
    }
  } finally {
    sends.delete(key);
  }
}

/**
 * Back-pressure: let the channel's send buffer drain before queueing more, so a
 * transfer can't balloon memory or starve the project doc's own messages.
 */
function waitForDrain(channel: RTCDataChannel): Promise<void> {
  if (channel.bufferedAmount < SEND_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    channel.bufferedAmountLowThreshold = SEND_LOW_WATER;
    let settled = false;
    const onLow = () => {
      if (settled) return;
      settled = true;
      channel.removeEventListener("bufferedamountlow", onLow);
      resolve();
    };
    channel.addEventListener("bufferedamountlow", onLow);
    // Safety net: the buffer can drain between the check above and the listener
    // being attached, in which case the event never fires.
    const poll = window.setInterval(() => {
      if (channel.bufferedAmount < SEND_HIGH_WATER || channel.readyState !== "open") {
        clearInterval(poll);
        onLow();
      }
    }, 100);
  });
}

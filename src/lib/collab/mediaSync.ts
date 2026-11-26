import { listen } from "@tauri-apps/api/event";
import { WebrtcProvider } from "y-webrtc";
import { createMediaChannels, dataFrame, type MediaChannel } from "@/lib/collab/mediaChannel";
import { getMediaStore, type MediaStore } from "@/lib/collab/mediaStore";
import { proxyArgs } from "@/lib/proxy";
import { isTauri } from "@/lib/platform";
import { usePrefs } from "@/state/prefs";
import { extractAudioTracks, ffmpegRun, ffprobeAudioStreams, type FfmpegExportProgress } from "@/lib/ffmpeg";
import { useEditor } from "@/state/editor";
import { clearTransfer, setFilesProgress, setQueued, setTransfer, useTransfers, type TransferVariant } from "@/state/transfers";
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
// PROXY FIRST: the usual ceiling is the sender's home upload (often ~20 Mbit/s,
// i.e. ~2.5 MB/s), and a multi-GB recording at that rate takes hours. So for
// big videos the holder first transcodes a small 720p editing copy (a "proxy")
// with ffmpeg and sends that; the receiver edits on it within minutes while the
// original follows in the background, then swaps in automatically. Export is
// blocked while any clip still sits on a proxy (see compileExport).
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
/**
 * How many files to download at once. One: parallel fetches split the same
 * peer link (and the sender's disk) between files, so every file crawls and
 * none becomes usable until the very end. Sequentially, each file arrives at
 * full speed and is playable as soon as it lands (#53).
 */
const MAX_ACTIVE_FETCHES = 1;
/** Videos smaller than this aren't worth a proxy — the original is quick anyway. */
const PROXY_MIN_BYTES = 48 * 1024 * 1024;
/** How often the holder reports proxy-encode progress while the receiver waits. */
const PREPARING_PING_MS = 1000;

// Diagnostic logging for the P2P media transfer. Visible in DevTools on both
// peers so a stalled transfer can be traced (discovery vs request vs blocks).
const log = (...args: unknown[]) => console.log("[mediaSync]", ...args);

// ── Active-session handles ───────────────────────────────────────────────────
let channels: ReturnType<typeof createMediaChannels> | null = null;
/** File access for this platform (disk on desktop, OPFS + blobs in the browser). */
let store: MediaStore | null = null;
/** Folder the user chose for finished downloads (#55); null = the private cache. */
let saveDir: string | null = null;
/** Originals that finished downloading this session, for the "2 / 15" counter. */
let filesDone = 0;
let mainAwareness: WebrtcProvider["awareness"] | null = null;
let clientId = 0;
let cacheDir = "";

let unsubStore: (() => void) | null = null;
let scanTimer: number | null = null;
let scanWantsHashes = false;
let watchdog: number | null = null;

/** fetch key -> timestamp before which we won't re-request it after a failure. */
const cooldowns = new Map<string, number>();
/** Content hashes whose proxy we gave up on (holder can't make one) — fetch the original directly. */
const noProxy = new Set<string>();
/** `${clientId}:${hash}` proxy-prepare hints already sent, so we don't repeat them. */
const hinted = new Set<string>();

/**
 * Files we serve that aren't project media — e.g. a video the host exported
 * for a browser collaborator. Advertised and served exactly like media.
 */
const extraFiles = new Map<string, { path: string; name: string; size: number; ext: string }>();

/** Transfers we're receiving, keyed by fetchKey(hash, variant). */
const fetches = new Map<string, FetchState>();
/** Transfers we're sending, keyed by `${peerId}:${transferId}`. */
const sends = new Map<string, SendState>();

interface FetchState {
  key: string;
  variant: TransferVariant;
  transferId: number;
  hash: string;
  mediaId: string;
  name: string;
  partPath: string;
  finalPath: string;
  /** sha256 the finished file must match: the content hash, or the proxy's own hash from the offer. */
  verifyHash: string | null;
  /** Bytes confirmed written to the .part file. */
  written: number;
  /** Bytes of the .part file already on disk from an interrupted earlier attempt. */
  resumeFrom: number;
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
  /** For a one-off file fetch (not project media): called instead of adopting it. */
  onDone?: (path: string) => void;
  onFail?: (why: string) => void;
  rateAt: number;
  rateBytes: number;
  done: boolean;
}

interface SendState {
  cancelled: boolean;
}

/** Progress of a file we're sending, mirrored into the transfers toast so the host sees it too. */
interface SendProgress {
  key: string;
  sent: number;
  size: number;
  rateAt: number;
  rateBytes: number;
}

function reportSend(p: SendProgress): void {
  const now = performance.now();
  const dt = now - p.rateAt;
  if (dt >= 500) {
    const rate = ((p.sent - p.rateBytes) * 1000) / dt;
    p.rateAt = now;
    p.rateBytes = p.sent;
    setTransfer(p.key, { received: p.sent, total: p.size, rate });
  } else {
    setTransfer(p.key, { received: p.sent, total: p.size });
  }
}

/** A collaborator's display name from awareness, for the upload rows. */
function peerName(chan: MediaChannel): string | undefined {
  if (chan.clientId == null) return undefined;
  const state = mainAwareness?.getStates().get(chan.clientId) as { name?: unknown } | undefined;
  return typeof state?.name === "string" && state.name.trim() ? state.name.trim() : undefined;
}

const fetchKey = (hash: string, variant: TransferVariant) => `${hash}:${variant}`;

const extOf = (src: string) => (src.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");

async function pathExists(path: string): Promise<boolean> {
  return store ? store.exists(path) : false;
}

export async function startMediaSync(roomId: string, mainProvider: WebrtcProvider): Promise<void> {
  await stopMediaSync();
  mainAwareness = mainProvider.awareness;
  clientId = mainAwareness.clientID;
  store = await getMediaStore();
  cacheDir = store.cacheDir;
  const prefs = usePrefs.getState();
  saveDir =
    isTauri() && !prefs.collabMediaTemp && prefs.collabMediaDir
      ? prefs.collabMediaDir.replace(/\\/g, "/").replace(/\/$/, "")
      : null;
  await store.ensureDir(cacheDir).catch(() => {});
  if (saveDir) await store.ensureDir(saveDir).catch(() => {});
  filesDone = 0;

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
  noProxy.clear();
  hinted.clear();
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
  useTransfers.setState({ transfers: {}, queued: 0, filesDone: 0, filesTotal: 0 });
  filesDone = 0;
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
// the set of hashes we can serve via the main awareness `have` field. A proxy
// isn't the file, so media we only hold a proxy of is never advertised.
async function refreshLocalHashes(): Promise<void> {
  const media = useEditor.getState().media;
  const have: string[] = [];
  for (const m of media) {
    if (!m.src || m.srcIsProxy) continue;
    if (!(await pathExists(m.src))) continue;
    let hash = m.contentHash;
    if (!hash || m.size == null || !m.ext) {
      try {
        hash = await store!.hash(m.src);
        const size = await store!.size(m.src);
        // A browser-imported file's src is a blob: URL with no extension.
        updateMediaLocal(m.id, { contentHash: hash, size, ext: extOf(m.src.startsWith("blob:") ? m.name : m.src) });
      } catch (err) {
        console.error("hash_file failed for", m.src, err);
        continue;
      }
    }
    if (hash) have.push(hash);
  }
  for (const hash of extraFiles.keys()) have.push(hash);
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

/** Fetches still moving bytes (a finished one that is only verifying doesn't count). */
function activeFetchCount(): number {
  let n = 0;
  for (const f of fetches.values()) if (!f.done) n++;
  return n;
}

/**
 * Media we don't hold the original of, in download order: anything placed on
 * the timeline first (that's what the user is about to look at), then library
 * order. Includes media we're currently editing on a proxy.
 */
function missingMediaInOrder(): MediaItem[] {
  const { media, clips } = useEditor.getState();
  const used = new Set<string>();
  for (const c of Object.values(clips)) if ("mediaId" in c) used.add(c.mediaId);
  const missing = media.filter((m) => (!m.src || m.srcIsProxy) && m.contentHash && m.ext);
  return [...missing.filter((m) => used.has(m.id)), ...missing.filter((m) => !used.has(m.id))];
}

/** Whether a missing file should come over as a proxy first. */
function wantsProxy(m: MediaItem): boolean {
  return (
    m.kind === "video" &&
    !m.srcIsProxy &&
    (m.size ?? 0) >= PROXY_MIN_BYTES &&
    !!m.contentHash &&
    !noProxy.has(m.contentHash)
  );
}

const cachedFullPath = (hash: string, ext: string) => `${cacheDir}/${hash}.${ext}`;

/**
 * Where an original goes when the user picked a download folder (#55): its real
 * name plus a short hash so two different files called "clip.mp4" can't collide.
 */
function savedFullPath(m: MediaItem): string | null {
  if (!saveDir || !m.contentHash || !m.ext) return null;
  const stem =
    m.name
      .replace(/\.[^.]+$/, "")
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
      .trim() || "media";
  return `${saveDir}/${stem} [${m.contentHash.slice(0, 8)}].${m.ext}`;
}
const proxyCachePath = (hash: string) => `${cacheDir}/${hash}.proxy.mp4`;

interface Job {
  media: MediaItem;
  variant: TransferVariant;
  finalPath: string;
}

// For each media we don't hold the original of: resolve from cache, or queue
// fetches from a peer — every proxy first (so the whole project becomes
// editable as fast as possible), then the originals. Downloads run
// MAX_ACTIVE_FETCHES at a time; the rest wait for the scan that runs when the
// current one finishes.
async function maybeFetchMissing(): Promise<void> {
  const proxyJobs: Job[] = [];
  const fullJobs: Job[] = [];

  for (const m of missingMediaInOrder()) {
    const hash = m.contentHash!;
    const saved = savedFullPath(m);
    const cached = cachedFullPath(hash, m.ext!);
    const fullPath = saved ?? cached;
    const proxyPath = proxyCachePath(hash);

    const existing =
      saved && (await pathExists(saved)) ? saved : (await pathExists(cached)) ? cached : null;
    if (existing) {
      log("resolved", m.name, "from", existing);
      await adoptOriginal(m.id, existing);
      continue;
    }
    if (wantsProxy(m)) {
      if (await pathExists(proxyPath)) {
        log("resolved", m.name, "proxy from local cache");
        await setMediaSrcLocal(m.id, proxyPath, true);
      } else {
        proxyJobs.push({ media: m, variant: "proxy", finalPath: proxyPath });
      }
    }
    fullJobs.push({ media: m, variant: "full", finalPath: fullPath });
  }

  hintProxies(proxyJobs);

  // From here on everything is synchronous, so the `fetches.has` check and the
  // `fetches.set` inside beginFetch can't interleave with an overlapping scan.
  let queued = 0;
  for (const job of [...proxyJobs, ...fullJobs]) {
    const hash = job.media.contentHash!;
    const key = fetchKey(hash, job.variant);
    if (fetches.has(key)) continue; // in progress
    const until = cooldowns.get(key);
    if (until != null && Date.now() < until) continue; // recently failed
    const holders = holdersOf(hash, new Set());
    if (holders.length === 0) continue; // nobody reachable has it — retry next scan
    if (activeFetchCount() >= MAX_ACTIVE_FETCHES) {
      queued++;
      continue;
    }
    log("need", job.variant, job.media.name, "hash", hash.slice(0, 8), "holders", holders);
    beginFetch(job);
  }
  setQueued(queued);
  // Originals still to come, plus the ones that already landed this session.
  setFilesProgress(filesDone, filesDone + fullJobs.length);
}

/**
 * Tell holders which proxies we're going to ask for, so they can encode the
 * next ones while the current one is still on the wire instead of only
 * starting when we ask.
 */
function hintProxies(jobs: Job[]): void {
  for (const job of jobs) {
    const hash = job.media.contentHash!;
    const holder = holdersOf(hash, new Set())[0];
    if (holder == null) continue;
    const tag = `${holder}:${hash}`;
    if (hinted.has(tag)) continue;
    const chan = channels?.byClientId(holder);
    if (!chan) continue;
    hinted.add(tag);
    chan.sendControl({ t: "prep", hash });
  }
}

async function setMediaSrcLocal(id: string, path: string, proxy = false): Promise<void> {
  // src is per-peer local and stripped by the reconciler, so this never syncs.
  // In the browser a cache path isn't playable; the store hands back a blob URL.
  const src = store ? await store.toSrc(path) : path;
  updateMediaLocal(id, { src, srcIsProxy: proxy || undefined });
  void ensureStreamFiles(id, src, proxy ? "proxy" : "full");
}

/** mediaId -> the file its audio streams were last extracted from. */
const streamsExtractedFrom = new Map<string, string>();

/**
 * Give a fetched multi-track video its own per-stream audio files, like the
 * import on the holder's side does. The track *list* (names, mutes) arrives
 * with the project; only the files are local. Without them every per-track
 * clip plays the whole muxed mix and the audio doubles up (#58).
 *
 * Runs again when the original replaces a proxy (the proxy keeps every audio
 * stream, so it works for that too). Each source gets its own folder: the old
 * files may still be open in the preview, and Windows won't overwrite those.
 */
async function ensureStreamFiles(mediaId: string, path: string, tag: "proxy" | "full"): Promise<void> {
  if (!store?.canExtractStreams) return; // the browser can't split streams; preview dedupes instead
  const m = useEditor.getState().media.find((x) => x.id === mediaId);
  if (!m || m.kind !== "video") return;
  if (streamsExtractedFrom.get(mediaId) === path) return;
  streamsExtractedFrom.set(mediaId, path);
  try {
    const streams = await ffprobeAudioStreams(path);
    if (streams.length <= 1) return; // one stream: the muxed audio is already right
    const extracted = await extractAudioTracks({
      sourcePath: path,
      mediaId: `${mediaId}/${tag}`,
      trackCount: streams.length,
    });
    const fileByIndex = new Map(extracted.map((e) => [e.index, e.filepath]));
    useEditor.setState((s) => ({
      media: s.media.map((cur) => {
        if (cur.id !== mediaId || cur.src !== path) return cur; // swapped again meanwhile
        const base =
          cur.audioTracks && cur.audioTracks.length > 0
            ? cur.audioTracks // keep the project's names + mutes
            : streams.map((st) => ({
                index: st.index,
                codec: st.codec,
                channels: st.channels,
                language: st.language,
                title: st.title,
                handlerName: st.handlerName,
                filepath: "",
                muted: false,
              }));
        return {
          ...cur,
          audioTracks: base.map((t) => ({ ...t, filepath: fileByIndex.get(t.index) ?? "" })),
        };
      }),
    }));
    log("extracted", extracted.length, "audio streams for", m.name);
  } catch (err) {
    streamsExtractedFrom.delete(mediaId); // let a later pass retry
    console.warn("[mediaSync] audio stream extraction failed for", m.name, err);
  }
}

/** Switch a media item onto its original file and drop the proxy it replaces. */
async function adoptOriginal(id: string, path: string): Promise<void> {
  const m = useEditor.getState().media.find((x) => x.id === id);
  const wasProxy = !!m?.srcIsProxy;
  const oldSrc = m?.src ?? "";
  await setMediaSrcLocal(id, path, false);
  if (wasProxy && m?.contentHash) {
    const proxyPath = proxyCachePath(m.contentHash);
    // The preview may still have the proxy open for a moment; Windows won't
    // delete an open file, so give it time to let go. Best effort either way.
    setTimeout(() => {
      void store?.remove(proxyPath).catch(() => {});
      if (oldSrc.startsWith("blob:")) URL.revokeObjectURL(oldSrc);
    }, 10_000);
  }
}

// ── Receiving ────────────────────────────────────────────────────────────────

function beginFetch(job: Job): void {
  const m = job.media;
  const hash = m.contentHash;
  if (!hash) return;
  const key = fetchKey(hash, job.variant);
  if (fetches.has(key)) return;

  const f: FetchState = {
    key,
    variant: job.variant,
    transferId: (crypto.getRandomValues(new Uint32Array(1))[0] || 1) >>> 0,
    hash,
    mediaId: m.id,
    name: m.name,
    partPath: `${job.finalPath}.part`,
    finalPath: job.finalPath,
    verifyHash: job.variant === "full" ? hash : null,
    written: 0,
    resumeFrom: 0,
    size: job.variant === "full" ? m.size ?? 0 : 0,
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
  fetches.set(key, f);
  setTransfer(key, { name: m.name, variant: job.variant, total: f.size, received: 0, status: "fetching" });

  // An original picks up where an interrupted attempt stopped (the .part file
  // survives failures; the final hash check still covers every byte). A proxy
  // always starts clean — a re-encode on the holder's side changes its bytes.
  f.writeChain = (async () => {
    if (job.variant === "full") {
      const have = await store!.size(f.partPath);
      if (have > 0 && (f.size === 0 || have < f.size)) {
        f.resumeFrom = have;
        f.written = have;
        f.rateBytes = have;
        setTransfer(key, { received: have });
        log("resuming", m.name, "from", have, "bytes");
      } else if (have > 0) {
        await store!.remove(f.partPath);
      }
    } else {
      await store!.remove(f.partPath);
    }
  })().catch((err) => console.error("Couldn't prepare partial:", err));

  void f.writeChain.then(() => askNextHolder(f));
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
  chan.sendControl({ t: "want", id: f.transferId, hash: f.hash, variant: f.variant, offset: f.resumeFrom });
  log("asked peer", holder, "for", f.variant, f.name, "transfer", f.transferId);

  if (f.offerTimer != null) clearTimeout(f.offerTimer);
  f.offerTimer = window.setTimeout(() => {
    f.offerTimer = null;
    if (f.done) return; // an offer / "preparing" clears this timer
    log("no offer for", f.name, "from peer", holder, "— trying another holder");
    askNextHolder(f);
  }, OFFER_TIMEOUT_MS);
}

/** Stop a fetch and remove it without counting it as a failure. */
function endFetch(f: FetchState): void {
  f.done = true;
  if (f.offerTimer != null) clearTimeout(f.offerTimer);
  fetches.delete(f.key);
}

function failFetch(f: FetchState, why: string): void {
  log("fetch failed for", f.variant, f.name, "—", why);
  endFetch(f);
  f.onFail?.(why);
  cooldowns.set(f.key, Date.now() + RETRY_COOLDOWN_MS);
  setTransfer(f.key, { status: "error", rate: 0 });
  // Leave the row up briefly so the failure is visible, then let the next scan
  // try again — a holder may come back online.
  setTimeout(() => clearTransfer(f.key), 6000);
  scheduleScan(); // start the next queued file
}

/** The holder can't give us a proxy: go straight for the original instead. */
function skipProxy(f: FetchState, why: string): void {
  log("no proxy for", f.name, "—", why, "— fetching the original instead");
  noProxy.add(f.hash);
  endFetch(f);
  clearTransfer(f.key);
  scheduleScan();
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
    case "prep":
      prepareProxyFor(String(msg.hash));
      return;
    case "preparing": {
      // The holder is still encoding our proxy. That's progress, not a stall.
      const f = fetchById(Number(msg.id));
      if (!f || f.done) return;
      if (f.offerTimer != null) {
        clearTimeout(f.offerTimer);
        f.offerTimer = null;
      }
      f.servingPeerId = chan.peerId;
      f.progressAt = performance.now();
      setTransfer(f.key, { status: "preparing", prepPercent: Number(msg.percent) || 0 });
      return;
    }
    case "offer": {
      const f = fetchById(Number(msg.id));
      if (!f) return;
      if (f.offerTimer != null) {
        clearTimeout(f.offerTimer);
        f.offerTimer = null;
      }
      if (f.variant === "proxy" && (msg.variant !== "proxy" || typeof msg.sha !== "string")) {
        // An older WeEdit that doesn't know proxies answered with the original.
        chan.sendControl({ t: "cancel", id: f.transferId });
        skipProxy(f, "holder doesn't support proxies");
        return;
      }
      if (f.variant === "proxy") f.verifyHash = String(msg.sha);
      f.size = Number(msg.size) || f.size;
      if ((Number(msg.offset) || 0) !== f.resumeFrom) {
        // The holder is sending from the start (an older WeEdit ignores the
        // offset): drop our partial so its bytes aren't appended twice.
        f.resumeFrom = 0;
        f.written = 0;
        f.rateBytes = 0;
        f.writeChain = f.writeChain.then(() => store!.remove(f.partPath)).catch(() => {});
      }
      f.servingPeerId = chan.peerId;
      f.progressAt = performance.now();
      setTransfer(f.key, { status: "fetching", total: f.size });
      log("offer accepted for", f.variant, f.name, "size", f.size);
      return;
    }
    case "deny": {
      const f = fetchById(Number(msg.id));
      if (!f) return;
      log("peer declined", f.name, "—", msg.reason);
      if (f.variant === "proxy" && msg.reason === "proxy unavailable") {
        skipProxy(f, "holder couldn't make one");
        return;
      }
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
      const wrote = await store!.append(f.partPath, block);
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
    setTransfer(f.key, { received: f.written, total: f.size, rate });
  } else {
    setTransfer(f.key, { received: f.written, total: f.size });
  }
}

async function finishFetch(f: FetchState): Promise<void> {
  if (f.done) return;
  f.done = true;
  // The link is free now — start the next queued file while this one verifies.
  scheduleScan();
  setTransfer(f.key, { status: "verifying", received: f.written, rate: 0 });
  try {
    const got = await store!.hash(f.partPath);
    if (!f.verifyHash || got !== f.verifyHash) {
      console.error("Hash mismatch for fetched media; discarding.");
      await store!.remove(f.partPath);
      f.onFail?.("the downloaded file didn't match (corrupted in transit)");
      cooldowns.set(f.key, Date.now() + RETRY_COOLDOWN_MS);
      setTransfer(f.key, { status: "error" });
      setTimeout(() => clearTransfer(f.key), 6000);
      return;
    }
    await store!.rename(f.partPath, f.finalPath);
    cooldowns.delete(f.key);
    if (f.onDone) {
      f.onDone(f.finalPath);
    } else if (f.variant === "full") {
      filesDone++;
      await adoptOriginal(f.mediaId, f.finalPath);
    } else {
      // Only if the original hasn't somehow beaten it here.
      const m = useEditor.getState().media.find((x) => x.id === f.mediaId);
      if (m && (!m.src || m.srcIsProxy)) await setMediaSrcLocal(f.mediaId, f.finalPath, true);
    }
    setTransfer(f.key, { status: "done" });
    log("fetch complete:", f.variant, f.finalPath);
    setTimeout(() => clearTransfer(f.key), 2500);
  } catch (err) {
    console.error("finishFetch failed:", err);
    f.onFail?.(String(err));
    setTransfer(f.key, { status: "error" });
    setTimeout(() => clearTransfer(f.key), 6000);
  } finally {
    fetches.delete(f.key);
  }
}

// ── Proxies (we hold the original) ───────────────────────────────────────────

/** In-flight or finished proxy encodes, by content hash. Survives sessions: the files are cached on disk. */
const proxyBuilds = new Map<string, Promise<{ path: string; sha: string; size: number }>>();
/** Encodes run one at a time so a joiner's whole library doesn't swamp the CPU. */
let proxyQueue: Promise<unknown> = Promise.resolve();
/** Encode progress (0..1) of the proxy currently being made, by content hash. */
const proxyProgress = new Map<string, number>();

/** The original of `hash` that we hold, if any (never a proxy). */
function heldOriginal(hash: string): MediaItem | null {
  const media = useEditor.getState().media.find((m) => m.contentHash === hash && !!m.src && !m.srcIsProxy);
  if (media) return media;
  const extra = extraFiles.get(hash);
  if (!extra) return null;
  // Shaped like media so serve() handles it the same way; never put in the store.
  return {
    id: `file-${hash}`,
    name: extra.name,
    kind: "video",
    src: extra.path,
    size: extra.size,
    contentHash: hash,
    ext: extra.ext,
    importedAt: 0,
  };
}

/** Offer a non-media file (by its content hash) to peers in this session. */
export async function shareFile(path: string, name: string): Promise<{ hash: string; size: number }> {
  if (!store) throw new Error("Not in a collaboration session.");
  const hash = await store.hash(path);
  const size = await store.size(path);
  extraFiles.set(hash, { path, name, size, ext: extOf(name) });
  scheduleScan(true); // re-advertise "have" with it
  return { hash, size };
}

/** Is some connected peer advertising this hash yet? */
export function isHeldByPeer(hash: string): boolean {
  return holdersOf(hash, new Set()).length > 0;
}

/**
 * Download a non-media file a peer shared, with the usual progress toast.
 * Resolves with something the browser can save/play (a path on desktop, a
 * blob: URL in the browser).
 */
export function fetchFile(hash: string, name: string, size: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!store) {
      reject(new Error("Not in a collaboration session."));
      return;
    }
    const ext = extOf(name);
    const pseudo: MediaItem = { id: `file-${hash}`, name, kind: "video", src: "", size, contentHash: hash, ext, importedAt: 0 };
    const key = fetchKey(hash, "full");
    beginFetch({ media: pseudo, variant: "full", finalPath: cachedFullPath(hash, ext) });
    const f = fetches.get(key);
    if (!f) {
      reject(new Error("Couldn't start the download."));
      return;
    }
    f.onDone = (path) => {
      void store!.toSrc(path).then(resolve, reject);
    };
    f.onFail = (why) => reject(new Error(why));
  });
}

/** A peer told us it will want this proxy soon: start encoding it in the background. */
function prepareProxyFor(hash: string): void {
  if (!store?.canMakeProxies) return;
  const m = heldOriginal(hash);
  if (!m || m.kind !== "video") return;
  ensureProxy(m).catch(() => {}); // a failure is reported when it's actually requested
}

function ensureProxy(m: MediaItem): Promise<{ path: string; sha: string; size: number }> {
  const hash = m.contentHash!;
  const existing = proxyBuilds.get(hash);
  if (existing) return existing;
  const job = proxyQueue.then(() => buildProxy(m));
  proxyQueue = job.catch(() => {});
  proxyBuilds.set(hash, job);
  job.catch((err) => {
    console.error("[mediaSync] proxy encode failed for", m.name, err);
  });
  return job;
}

async function buildProxy(m: MediaItem): Promise<{ path: string; sha: string; size: number }> {
  const hash = m.contentHash!;
  // Already made an editing copy of this file for our own preview? Send that.
  if (m.previewSrc && (await pathExists(m.previewSrc))) {
    return { path: m.previewSrc, sha: await store!.hash(m.previewSrc), size: await store!.size(m.previewSrc) };
  }
  const dir = `${cacheDir}/proxies`;
  const out = `${dir}/${hash}.mp4`;

  if (!(await pathExists(out))) {
    await store!.ensureDir(dir);
    const tmp = `${dir}/${hash}.tmp.mp4`;
    const id = `proxy-${hash.slice(0, 16)}-${Date.now()}`;
    proxyProgress.set(hash, 0);
    const unlisten = await listen<FfmpegExportProgress>("ffmpeg-progress", (e) => {
      if (e.payload.id === id && e.payload.percent != null) proxyProgress.set(hash, e.payload.percent);
    });
    log("encoding proxy for", m.name);
    try {
      await ffmpegRun({ args: proxyArgs(m.src, tmp), exportId: id, totalDurationSec: m.durationSec ?? 0 });
      await store!.rename(tmp, out);
    } catch (err) {
      store!.remove(tmp).catch(() => {});
      throw err;
    } finally {
      unlisten();
      proxyProgress.delete(hash);
    }
    log("proxy ready for", m.name);
  }

  const sha = await store!.hash(out);
  const size = await store!.size(out);
  return { path: out, sha, size };
}

// ── Serving (we hold the file) ───────────────────────────────────────────────

async function serve(chan: MediaChannel, msg: Record<string, unknown>): Promise<void> {
  const transferId = Number(msg.id);
  const hash = String(msg.hash);
  const variant: TransferVariant = msg.variant === "proxy" ? "proxy" : "full";
  const key = `${chan.peerId}:${transferId}`;
  if (sends.has(key)) return;

  const local = heldOriginal(hash);
  if (!local?.src) {
    log("got a request for", hash.slice(0, 8), "but I don't hold that file");
    chan.sendControl({ t: "deny", id: transferId, reason: "not held" });
    return;
  }

  const state: SendState = { cancelled: false };
  sends.set(key, state);
  const upKey = `up:${key}`;
  let outcome: "done" | "error" | "quiet" = "quiet";
  setTransfer(upKey, {
    name: local.name,
    variant,
    direction: "up",
    peer: peerName(chan),
    status: variant === "proxy" ? "preparing" : "fetching",
    total: variant === "proxy" ? 0 : local.size ?? 0,
  });
  try {
    let path = local.src;
    let size: number;
    let sha: string | undefined;

    if (variant === "proxy") {
      // Keep the receiver posted while ffmpeg works, so it neither times the
      // request out nor shows a frozen row.
      const ping = () => {
        const percent = proxyProgress.get(hash) ?? 0;
        chan.sendControl({ t: "preparing", id: transferId, percent });
        setTransfer(upKey, { prepPercent: percent });
      };
      ping();
      const timer = window.setInterval(ping, PREPARING_PING_MS);
      try {
        if (!store?.canMakeProxies) throw new Error("this peer can't make proxies");
        const proxy = await ensureProxy(local);
        path = proxy.path;
        size = proxy.size;
        sha = proxy.sha;
      } catch {
        proxyBuilds.delete(hash); // let a later request try again
        if (chan.channel.readyState === "open") {
          chan.sendControl({ t: "deny", id: transferId, reason: "proxy unavailable" });
        }
        outcome = "error";
        return;
      } finally {
        clearInterval(timer);
      }
      if (state.cancelled || chan.channel.readyState !== "open") return;
    } else {
      size = local.size ?? (await store!.size(local.src));
    }

    // Resume: an original can start part-way in, where the receiver's partial
    // file ends. (A proxy always starts at 0.)
    const startAt = variant === "full" ? Math.max(0, Math.min(size, Number(msg.offset) || 0)) : 0;
    chan.sendControl({ t: "offer", id: transferId, size, variant, sha, offset: startAt });
    const progress: SendProgress = { key: upKey, sent: startAt, size, rateAt: performance.now(), rateBytes: startAt };
    setTransfer(upKey, { status: "fetching", total: size, received: startAt });
    log("serving", variant, local.name, size, "bytes to", chan.peerId.slice(0, 8));

    // Compression is decided per file from its first block: deflate buys a lot
    // on WAV / image sequences / subtitles and nothing at all on h264/h265, and
    // the sender pays the CPU either way. Probe once, then stick with it.
    let compress: boolean = true;
    let probed = false;
    const readBlock = (offset: number): Promise<ArrayBuffer> => {
      const p = store!.readBlock(path, offset, Math.min(BLOCK_BYTES, size - offset), compress);
      p.catch(() => {}); // if we bail out before awaiting it, don't warn
      return p;
    };

    // Read ahead one block: the next disk read (and deflate) runs while the
    // current block is still going out, instead of the link idling on it.
    let nextRead: Promise<ArrayBuffer> | null = startAt < size ? readBlock(startAt) : null;
    for (let offset = startAt; offset < size && nextRead; offset += BLOCK_BYTES) {
      if (state.cancelled || chan.channel.readyState !== "open") {
        log("send cancelled for", local.name);
        return;
      }
      const raw: ArrayBuffer = await nextRead;
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
      // Issued after the probe so it uses the settled compression choice.
      const nextOffset = offset + BLOCK_BYTES;
      nextRead = nextOffset < size ? readBlock(nextOffset) : null;

      chan.sendControl({ t: "block", id: transferId, encLen: block.byteLength });
      for (let at = 0; at < block.byteLength; at += FRAME_BYTES) {
        if (state.cancelled || chan.channel.readyState !== "open") return;
        await waitForDrain(chan.channel);
        chan.channel.send(dataFrame(transferId, block.subarray(at, at + FRAME_BYTES)));
      }
      progress.sent = Math.min(size, offset + BLOCK_BYTES);
      reportSend(progress);
    }

    if (!state.cancelled && chan.channel.readyState === "open") {
      chan.sendControl({ t: "end", id: transferId });
      log("sent all of", variant, local.name);
      outcome = "done";
    } else if (chan.channel.readyState !== "open") {
      outcome = "error"; // collaborator left mid-transfer
    }
  } catch (err) {
    console.error("[mediaSync] serve failed:", err);
    outcome = "error";
    if (chan.channel.readyState === "open") {
      chan.sendControl({ t: "end", id: transferId, error: String(err) });
    }
  } finally {
    sends.delete(key);
    if (outcome === "done") {
      setTransfer(upKey, { status: "done", rate: 0 });
      setTimeout(() => clearTransfer(upKey), 2500);
    } else if (outcome === "error") {
      setTransfer(upKey, { status: "error", rate: 0 });
      setTimeout(() => clearTransfer(upKey), 6000);
    } else {
      clearTransfer(upKey); // the receiver cancelled on purpose — nothing to report
    }
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

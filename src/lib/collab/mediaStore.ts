import { isTauri } from "@/lib/platform";
import { sha256Blob } from "@/lib/collab/sha256";

// Where collaboration media lives, and how its bytes are read and written.
//
// mediaSync speaks one protocol on every platform; this is the part that
// differs. The desktop app goes through the Rust commands (files on disk). The
// browser editor keeps downloads in the Origin Private File System — real files
// that can be appended to block by block and outlive a reload — and reads the
// files a web user shares straight from the Blob behind their `blob:` URL.
//
// Path strings are opaque to mediaSync: absolute paths on desktop, `opfs:<name>`
// in the browser. A media item's playable `src` is the path itself on desktop
// and a `blob:` URL in the browser (see `toSrc`).

/** Block codec byte, shared with the Rust side. */
export const CODEC_STORED = 0;
export const CODEC_DEFLATE = 1;

export interface MediaStore {
  /** Can this peer transcode proxies (needs ffmpeg)? */
  readonly canMakeProxies: boolean;
  /** Can this peer split a video's audio streams into their own files? */
  readonly canExtractStreams: boolean;
  /** Folder of the private download cache (desktop path / OPFS prefix). */
  readonly cacheDir: string;
  /** Does this file exist? Works for cache paths and for media `src` values. */
  exists(path: string): Promise<boolean>;
  /** Size in bytes, or 0 if it doesn't exist. */
  size(path: string): Promise<number>;
  remove(path: string): Promise<void>;
  /** Append a `[codec][payload]` block, inflating if needed. Returns file bytes written. */
  append(path: string, block: Uint8Array): Promise<number>;
  rename(from: string, to: string): Promise<void>;
  ensureDir(dir: string): Promise<void>;
  /** Streamed SHA-256 (lowercase hex) of a cache path or a media `src`. */
  hash(path: string): Promise<string>;
  /** Up to `length` bytes at `offset` as a `[codec][payload]` block. */
  readBlock(path: string, offset: number, length: number, compress: boolean): Promise<ArrayBuffer>;
  /** Turn a finished cache path into something a <video>/<audio> can play. */
  toSrc(path: string): Promise<string>;
}

/** Paths cross the IPC header as URL-safe base64 to survive non-ASCII names. */
function encodePathHeader(path: string): string {
  const bytes = new TextEncoder().encode(path);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── Desktop ──────────────────────────────────────────────────────────────────

async function createTauriStore(): Promise<MediaStore> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { appLocalDataDir } = await import("@tauri-apps/api/path");
  const base = (await appLocalDataDir()).replace(/\\/g, "/").replace(/\/$/, "");

  return {
    canMakeProxies: true,
    canExtractStreams: true,
    cacheDir: `${base}/collab-media`,
    exists: async (path) => {
      try {
        return await invoke<boolean>("path_exists", { path });
      } catch {
        return false;
      }
    },
    size: async (path) => {
      try {
        return await invoke<number>("file_size", { path });
      } catch {
        return 0;
      }
    },
    remove: async (path) => {
      await invoke("remove_file", { path });
    },
    append: (path, block) =>
      invoke<number>("append_media_block", block.buffer as ArrayBuffer, {
        headers: { "x-weedit-path": encodePathHeader(path) },
      }),
    rename: async (from, to) => {
      await invoke("rename_path", { from, to });
    },
    ensureDir: async (dir) => {
      await invoke("ensure_dir", { path: dir });
    },
    hash: (path) => invoke<string>("hash_file", { path }),
    readBlock: (path, offset, length, compress) =>
      invoke<ArrayBuffer>("read_media_block", { path, offset, length, compress }),
    toSrc: async (path) => path,
  };
}

// ── Browser ──────────────────────────────────────────────────────────────────

const OPFS_PREFIX = "opfs:";
const OPFS_DIR = "collab-media";

async function createWebStore(): Promise<MediaStore> {
  const root = await navigator.storage.getDirectory();
  const dir = await root.getDirectoryHandle(OPFS_DIR, { create: true });
  // Ask the browser not to evict our downloads under storage pressure.
  void navigator.storage.persist?.().catch(() => false);

  const nameOf = (path: string) => path.slice(OPFS_PREFIX.length).split("/").pop()!;
  const isOpfs = (path: string) => path.startsWith(OPFS_PREFIX);

  /** Blobs behind `blob:` URLs, so a send doesn't refetch the URL per block. */
  const blobCache = new Map<string, Blob>();
  async function blobOf(path: string): Promise<Blob> {
    if (isOpfs(path)) {
      const handle = await dir.getFileHandle(nameOf(path));
      return handle.getFile();
    }
    let blob = blobCache.get(path);
    if (!blob) {
      blob = await (await fetch(path)).blob();
      blobCache.set(path, blob);
    }
    return blob;
  }

  async function inflate(payload: Uint8Array): Promise<Uint8Array> {
    const stream = new Blob([payload as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  return {
    canMakeProxies: false,
    canExtractStreams: false,
    cacheDir: `${OPFS_PREFIX}${OPFS_DIR}`,
    exists: async (path) => {
      try {
        await blobOf(path);
        return true;
      } catch {
        return false;
      }
    },
    size: async (path) => {
      try {
        return (await blobOf(path)).size;
      } catch {
        return 0;
      }
    },
    remove: async (path) => {
      if (!isOpfs(path)) return;
      try {
        await dir.removeEntry(nameOf(path));
      } catch {
        // already gone
      }
    },
    append: async (path, block) => {
      const codec = block[0];
      const payload = block.subarray(1);
      const bytes = codec === CODEC_DEFLATE ? await inflate(payload) : payload;
      const handle = await dir.getFileHandle(nameOf(path), { create: true });
      const writable = await handle.createWritable({ keepExistingData: true });
      try {
        const size = (await handle.getFile()).size;
        await writable.write({ type: "write", position: size, data: bytes as BufferSource });
      } finally {
        await writable.close();
      }
      return bytes.byteLength;
    },
    rename: async (from, to) => {
      const src = await dir.getFileHandle(nameOf(from));
      const moveable = src as FileSystemFileHandle & { move?: (name: string) => Promise<void> };
      if (typeof moveable.move === "function") {
        await moveable.move(nameOf(to));
        return;
      }
      // No move() in this browser: copy, then drop the original.
      const dst = await dir.getFileHandle(nameOf(to), { create: true });
      const writable = await dst.createWritable();
      await (await src.getFile()).stream().pipeTo(writable);
      await dir.removeEntry(nameOf(from));
    },
    ensureDir: async () => {},
    hash: async (path) => sha256Blob(await blobOf(path)),
    readBlock: async (path, offset, length) => {
      // The browser never compresses: video doesn't shrink, and the CPU is the
      // user's tab. The receiver handles stored blocks on every platform.
      const part = new Uint8Array(await (await blobOf(path)).slice(offset, offset + length).arrayBuffer());
      const out = new Uint8Array(part.byteLength + 1);
      out[0] = CODEC_STORED;
      out.set(part, 1);
      return out.buffer;
    },
    toSrc: async (path) => {
      if (!isOpfs(path)) return path;
      const file = await (await dir.getFileHandle(nameOf(path))).getFile();
      const url = URL.createObjectURL(file);
      blobCache.set(url, file);
      return url;
    },
  };
}

let storePromise: Promise<MediaStore> | null = null;

/** The media store for this platform (created once). */
export function getMediaStore(): Promise<MediaStore> {
  storePromise ??= isTauri() ? createTauriStore() : createWebStore();
  return storePromise;
}

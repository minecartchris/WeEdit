// Unified search across all configured audio providers. Each provider is
// optional — when a key isn't set, that source is silently skipped.
//
// One day this is also where Pixabay / Free Music Archive / Internet Archive
// adapters would slot in if we wired them.

import { searchFreesound, type FreesoundResult } from "@/lib/freesound";
import { searchJamendoTracks, type JamendoTrack } from "@/lib/jamendo";
import { ncsTrackTitle, searchNcs, type NcsTrack } from "@/lib/ncs";

export type AudioSource = "freesound" | "jamendo" | "ncs";

export interface StockAudio {
  source: AudioSource;
  /** Source-internal id, prefixed so it's unique across providers. */
  uid: string;
  title: string;
  author: string;
  durationSec: number;
  /** Streaming preview URL — what we play in the audio element. */
  previewUrl: string;
  /** Optional higher-quality download URL when the API exposes one. */
  downloadUrl?: string;
  /** Human-readable detail page (opens in browser). */
  detailUrl: string;
  /** Optional thumbnail image (NCS has one; Freesound/Jamendo typically don't). */
  thumbnail?: string;
  /**
   * If set, this URL must be fetched via yt-dlp (audio_only) instead of plain
   * http_download. Used for NCS, where the only download path is the YouTube
   * video page rather than a direct MP3.
   */
  ytdlpUrl?: string;
  license?: string;
}

export interface AudioPage {
  results: StockAudio[];
  /** Per-source next page tokens. Used by `loadMoreAudio`. */
  next: { freesound?: number | null; jamendo?: number | null; ncs?: number | null };
  /** Errors per source so the UI can surface them inline. */
  errors: { freesound?: string; jamendo?: string; ncs?: string };
}

interface SearchOpts {
  freesoundKey: string | null;
  jamendoKey: string | null;
  query: string;
}

function toFreesound(r: FreesoundResult): StockAudio {
  return {
    source: "freesound",
    uid: `freesound-${r.id}`,
    title: r.name,
    author: r.username,
    durationSec: r.duration,
    previewUrl: r.previews["preview-hq-mp3"],
    detailUrl: r.url,
    license: r.license,
  };
}

function toJamendo(t: JamendoTrack): StockAudio {
  return {
    source: "jamendo",
    uid: `jamendo-${t.id}`,
    title: t.name,
    author: t.artist_name,
    durationSec: t.duration,
    previewUrl: t.audio,
    downloadUrl: t.audiodownload_allowed ? t.audiodownload || t.audio : t.audio,
    detailUrl: t.shareurl,
  };
}

function toNcs(t: NcsTrack): StockAudio {
  return {
    source: "ncs",
    uid: `ncs-${t.id}`,
    title: ncsTrackTitle(t.title),
    author: t.artist,
    durationSec: t.durationSec,
    // No direct preview MP3 — fallback to YouTube URL (we'll handle play-in-browser
    // in the UI rather than try to feed it to an <audio> element).
    previewUrl: t.youtubeUrl,
    detailUrl: t.youtubeUrl,
    thumbnail: t.thumbnail,
    ytdlpUrl: t.youtubeUrl,
  };
}

export async function searchAudio({ freesoundKey, jamendoKey, query }: SearchOpts): Promise<AudioPage> {
  const out: AudioPage = { results: [], next: {}, errors: {} };

  const tasks: Promise<void>[] = [];

  if (freesoundKey) {
    tasks.push(
      searchFreesound(freesoundKey, query, 1, 20)
        .then((r) => {
          out.results.push(...r.results.map(toFreesound));
          out.next.freesound = r.nextPage;
        })
        .catch((err) => {
          out.errors.freesound = err instanceof Error ? err.message : String(err);
        }),
    );
  }

  if (jamendoKey) {
    tasks.push(
      searchJamendoTracks(jamendoKey, query, 1, 20)
        .then((r) => {
          out.results.push(...r.tracks.map(toJamendo));
          out.next.jamendo = r.nextPage;
        })
        .catch((err) => {
          out.errors.jamendo = err instanceof Error ? err.message : String(err);
        }),
    );
  }

  // NCS is always queried — uses yt-dlp under the hood, no API key needed.
  tasks.push(
    searchNcs(query, 18)
      .then((tracks) => {
        out.results.push(...tracks.map(toNcs));
        // yt-dlp returns the whole result set; no pagination cursor.
        out.next.ncs = null;
      })
      .catch((err) => {
        out.errors.ncs = err instanceof Error ? err.message : String(err);
      }),
  );

  await Promise.all(tasks);

  // Interleave so a search that returns many results from one source doesn't
  // visually drown the others.
  out.results = interleave(out.results);

  return out;
}

export async function loadMoreAudio(
  opts: SearchOpts & { next: AudioPage["next"] },
): Promise<AudioPage> {
  const { freesoundKey, jamendoKey, query, next } = opts;
  const out: AudioPage = { results: [], next: {}, errors: {} };
  const tasks: Promise<void>[] = [];

  if (freesoundKey && next.freesound) {
    const page = next.freesound;
    tasks.push(
      searchFreesound(freesoundKey, query, page, 20)
        .then((r) => {
          out.results.push(...r.results.map(toFreesound));
          out.next.freesound = r.nextPage;
        })
        .catch((err) => {
          out.errors.freesound = err instanceof Error ? err.message : String(err);
        }),
    );
  } else {
    out.next.freesound = next.freesound;
  }

  if (jamendoKey && next.jamendo) {
    const page = next.jamendo;
    tasks.push(
      searchJamendoTracks(jamendoKey, query, page, 20)
        .then((r) => {
          out.results.push(...r.tracks.map(toJamendo));
          out.next.jamendo = r.nextPage;
        })
        .catch((err) => {
          out.errors.jamendo = err instanceof Error ? err.message : String(err);
        }),
    );
  } else {
    out.next.jamendo = next.jamendo;
  }

  await Promise.all(tasks);
  out.results = interleave(out.results);
  return out;
}

function interleave(list: StockAudio[]): StockAudio[] {
  const buckets = new Map<AudioSource, StockAudio[]>();
  for (const x of list) {
    if (!buckets.has(x.source)) buckets.set(x.source, []);
    buckets.get(x.source)!.push(x);
  }
  const sources = [...buckets.keys()];
  const out: StockAudio[] = [];
  let progress = true;
  while (progress) {
    progress = false;
    for (const s of sources) {
      const arr = buckets.get(s)!;
      if (arr.length > 0) {
        out.push(arr.shift()!);
        progress = true;
      }
    }
  }
  return out;
}

export function formatAudioDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

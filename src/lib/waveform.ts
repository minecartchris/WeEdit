// Decodes audio peak data for timeline waveform rendering. Peaks are cached
// per media item (in-memory, for the session) so scrolling/zooming the
// timeline or duplicating a clip doesn't re-decode the source.

import { useEffect, useState } from "react";
import { toPlayableUrl } from "@/lib/media";
import type { MediaItem } from "@/types";

export interface WaveformData {
  /** Peak amplitude (0..1) per time bucket, across all channels. */
  peaks: Float32Array;
  /** Resolution of `peaks` — number of buckets per second of source audio. */
  bucketsPerSec: number;
}

const BUCKETS_PER_SEC = 50;
// Caps memory for very long sources (e.g. multi-hour VODs) by lowering
// resolution rather than growing the array unbounded.
const MAX_BUCKETS = 200_000;

// Decoding pulls the ENTIRE source into memory (fetch → ArrayBuffer →
// decodeAudioData → PCM). For a multi-hour Twitch VOD that's gigabytes and
// crashes the WebView2 renderer outright — which is exactly what happens after
// "Detach audio", since the detached audio clip points at the original (huge)
// video file. So skip the real waveform past a safe duration and let the
// placeholder bars stand in. Video sources also carry the video bitstream in
// the bytes we fetch, so they get a tighter cap than audio-only sources.
const MAX_AUDIO_SOURCE_SEC = 30 * 60;
const MAX_VIDEO_SOURCE_SEC = 10 * 60;

/** Whether a source is small enough to decode client-side without risking OOM. */
function isWaveformSafe(media: MediaItem): boolean {
  const cap = media.kind === "video" ? MAX_VIDEO_SOURCE_SEC : MAX_AUDIO_SOURCE_SEC;
  return media.durationSec != null && media.durationSec > 0 && media.durationSec <= cap;
}

const cache = new Map<string, WaveformData>();
const inFlight = new Map<string, Promise<WaveformData | null>>();

function computePeaks(buffer: AudioBuffer): WaveformData {
  let bucketCount = Math.max(1, Math.ceil(buffer.duration * BUCKETS_PER_SEC));
  let bucketsPerSec = BUCKETS_PER_SEC;
  if (bucketCount > MAX_BUCKETS) {
    bucketCount = MAX_BUCKETS;
    bucketsPerSec = bucketCount / buffer.duration;
  }

  const peaks = new Float32Array(bucketCount);
  const samplesPerBucket = Math.max(1, Math.floor(buffer.length / bucketCount));

  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const channel = buffer.getChannelData(c);
    for (let b = 0; b < bucketCount; b++) {
      const start = b * samplesPerBucket;
      const end = Math.min(channel.length, start + samplesPerBucket);
      let peak = 0;
      for (let i = start; i < end; i++) {
        const v = Math.abs(channel[i]);
        if (v > peak) peak = v;
      }
      if (peak > peaks[b]) peaks[b] = peak;
    }
  }

  return { peaks, bucketsPerSec };
}

async function decode(media: MediaItem): Promise<WaveformData | null> {
  try {
    const res = await fetch(toPlayableUrl(media.src));
    const bytes = await res.arrayBuffer();
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    try {
      const buffer = await ctx.decodeAudioData(bytes);
      return computePeaks(buffer);
    } finally {
      void ctx.close();
    }
  } catch (err) {
    console.warn(`Waveform decode failed for ${media.name}:`, err);
    return null;
  }
}

function loadWaveform(media: MediaItem): Promise<WaveformData | null> {
  const cached = cache.get(media.id);
  if (cached) return Promise.resolve(cached);

  // Bail before fetching anything for sources too large to decode safely.
  if (!isWaveformSafe(media)) return Promise.resolve(null);

  let pending = inFlight.get(media.id);
  if (!pending) {
    pending = decode(media).then((data) => {
      inFlight.delete(media.id);
      if (data) cache.set(media.id, data);
      return data;
    });
    inFlight.set(media.id, pending);
  }
  return pending;
}

/** Peak waveform data for a media item, decoded lazily and cached. Returns
 *  `null` while decoding (or if decoding isn't possible for this source). */
export function useWaveform(media: MediaItem | undefined): WaveformData | null {
  const [data, setData] = useState<WaveformData | null>(
    () => (media ? cache.get(media.id) ?? null : null),
  );

  useEffect(() => {
    if (!media) {
      setData(null);
      return;
    }
    const cached = cache.get(media.id);
    if (cached) {
      setData(cached);
      return;
    }
    setData(null);
    let cancelled = false;
    loadWaveform(media).then((wf) => {
      if (!cancelled) setData(wf);
    });
    return () => {
      cancelled = true;
    };
  }, [media]);

  return data;
}

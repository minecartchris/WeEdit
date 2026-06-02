import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef } from "react";
import { useEditor } from "@/state/editor";
import type { AspectRatio, MediaClip, MediaItem, TextClip } from "@/types";

// Stage that renders whatever clip is active at the playhead. Phase-2-MVP version:
// - Topmost video clip drives a single <video> element.
// - Audio tracks each get a hidden <audio> element synced to the playhead.
// - Text clips render as absolutely-positioned divs over the video.
//
// Phase 3 will replace this with a WebGPU compositor so multiple video tracks
// can layer with proper opacity / blend / filters, all on the GPU.

interface Props {
  aspect: AspectRatio;
}

export function PreviewStage({ aspect }: Props) {
  const playheadSec = useEditor((s) => s.playheadSec);
  const isPlaying = useEditor((s) => s.isPlaying);
  const tracks = useEditor((s) => s.tracks);
  const clips = useEditor((s) => s.clips);
  const media = useEditor((s) => s.media);

  const activeVideo: MediaClip | null = useMemo(() => {
    const ranked = [...tracks]
      .filter((t) => t.kind === "video")
      .sort((a, b) => b.zIndex - a.zIndex);
    for (const track of ranked) {
      for (const cid of track.clipIds) {
        const c = clips[cid];
        if (!c || c.kind === "text") continue;
        if (c.startSec <= playheadSec && playheadSec < c.startSec + c.durationSec) {
          return c as MediaClip;
        }
      }
    }
    return null;
  }, [tracks, clips, playheadSec]);

  const activeMedia: MediaItem | null = useMemo(
    () => (activeVideo ? media.find((m) => m.id === activeVideo.mediaId) ?? null : null),
    [activeVideo, media],
  );

  const activeTexts: TextClip[] = useMemo(() => {
    const out: TextClip[] = [];
    for (const c of Object.values(clips)) {
      if (c.kind !== "text") continue;
      if (c.startSec <= playheadSec && playheadSec < c.startSec + c.durationSec) {
        out.push(c);
      }
    }
    return out;
  }, [clips, playheadSec]);

  const activeAudios = useMemo(
    () => collectActiveAudios(tracks, clips, media, playheadSec),
    [tracks, clips, media, playheadSec],
  );

  const videoVolume = useMemo(() => {
    if (!activeVideo) return 0;
    const track = tracks.find((t) => t.id === activeVideo.trackId);
    if (!track) return 0;
    if (track.muted) return 0;
    return clamp01(activeVideo.volume * track.volume);
  }, [activeVideo, tracks]);

  return (
    <StageFrame aspect={aspect}>
      {activeMedia?.kind === "video" && activeVideo ? (
        <VideoLayer
          media={activeMedia}
          clip={activeVideo}
          playheadSec={playheadSec}
          isPlaying={isPlaying}
          volume={videoVolume}
        />
      ) : activeMedia?.kind === "image" && activeVideo ? (
        <ImageLayer media={activeMedia} clip={activeVideo} />
      ) : (
        <EmptyStage />
      )}

      {activeTexts.map((t) => (
        <TextLayer key={t.id} clip={t} />
      ))}

      {activeAudios.map((a) => (
        <AudioLayer key={a.clip.id} {...a} isPlaying={isPlaying} playheadSec={playheadSec} />
      ))}
    </StageFrame>
  );
}

// ── Layers ─────────────────────────────────────────────────────────────────

function VideoLayer({
  media,
  clip,
  playheadSec,
  isPlaying,
  volume,
}: {
  media: MediaItem;
  clip: MediaClip;
  playheadSec: number;
  isPlaying: boolean;
  volume: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const multiTrack = (media.audioTracks?.length ?? 0) > 0;

  // Sync currentTime to (playhead - clip.startSec + clip.sourceInSec).
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const target = playheadSec - clip.startSec + clip.sourceInSec;
    if (Number.isFinite(target) && Math.abs(v.currentTime - target) > 0.1) {
      try {
        v.currentTime = target;
      } catch {
        /* seek failed mid-load */
      }
    }
  }, [playheadSec, clip.startSec, clip.sourceInSec]);

  // Drive play/pause off isPlaying.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (isPlaying) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  }, [isPlaying]);

  // Volume + opacity. When multi-track is active we mute the muxed audio
  // entirely — individual <audio> elements (rendered as siblings) carry the
  // actual sound, so the user can mute each independently.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (multiTrack) {
      v.muted = true;
      v.volume = 0;
    } else {
      v.volume = volume;
      v.muted = volume <= 0;
    }
  }, [volume, multiTrack]);

  return (
    <>
      <div style={transformStyle(clip)}>
        <video
          ref={ref}
          src={convertFileSrc(media.src)}
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          className="w-full h-full object-contain"
          style={{ opacity: clip.opacity }}
        />
      </div>
      {multiTrack &&
        media.audioTracks!.map((t) => (
          <ExtractedAudioTrack
            key={t.index}
            track={t}
            clip={clip}
            isPlaying={isPlaying}
            playheadSec={playheadSec}
            trackVolume={volume}
          />
        ))}
    </>
  );
}

function ExtractedAudioTrack({
  track,
  clip,
  isPlaying,
  playheadSec,
  trackVolume,
}: {
  track: import("@/types").AudioTrackInfo;
  clip: MediaClip;
  isPlaying: boolean;
  playheadSec: number;
  trackVolume: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const effectiveVolume = track.muted ? 0 : trackVolume;

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const target = playheadSec - clip.startSec + clip.sourceInSec;
    if (Number.isFinite(target) && Math.abs(a.currentTime - target) > 0.1) {
      try {
        a.currentTime = target;
      } catch {
        /* seek failed mid-load */
      }
    }
  }, [playheadSec, clip.startSec, clip.sourceInSec]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (isPlaying) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = effectiveVolume;
    a.muted = effectiveVolume <= 0;
  }, [effectiveVolume]);

  if (!track.filepath) return null;
  return (
    <audio
      ref={ref}
      src={convertFileSrc(track.filepath)}
      preload="auto"
      crossOrigin="anonymous"
    />
  );
}

function ImageLayer({ media, clip }: { media: MediaItem; clip: MediaClip }) {
  return (
    <div style={transformStyle(clip)}>
      <img
        src={convertFileSrc(media.src)}
        alt=""
        className="w-full h-full object-contain"
        style={{ opacity: clip.opacity }}
      />
    </div>
  );
}

function TextLayer({ clip }: { clip: TextClip }) {
  return (
    <div
      className="absolute whitespace-pre-wrap text-center"
      style={{
        left: `${clip.xPct}%`,
        top: `${clip.yPct}%`,
        transform: `translate(-50%, -50%) scale(${clip.scale})`,
        transformOrigin: "center",
        fontFamily: clip.fontFamily,
        fontSize: `${clip.fontSizePx}px`,
        color: clip.color,
        textShadow: "0 2px 12px rgba(0,0,0,0.55)",
        pointerEvents: "none",
      }}
    >
      {clip.text}
    </div>
  );
}

// Absolute, stage-sized box centered on (xPct,yPct) and scaled. Media fills it
// with object-contain, so the default 50/50/scale-1 overlays the whole stage
// exactly as before; changing the transform moves/zooms the layer.
function transformStyle(t: { xPct: number; yPct: number; scale: number }): React.CSSProperties {
  return {
    position: "absolute",
    left: `${t.xPct}%`,
    top: `${t.yPct}%`,
    width: "100%",
    height: "100%",
    transform: `translate(-50%, -50%) scale(${t.scale})`,
    transformOrigin: "center",
  };
}

interface ActiveAudio {
  clip: MediaClip;
  media: MediaItem;
  volume: number;
}

function AudioLayer({
  clip,
  media,
  volume,
  isPlaying,
  playheadSec,
}: ActiveAudio & { isPlaying: boolean; playheadSec: number }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const target = playheadSec - clip.startSec + clip.sourceInSec;
    if (Number.isFinite(target) && Math.abs(a.currentTime - target) > 0.1) {
      try {
        a.currentTime = target;
      } catch {
        /* seek failed mid-load */
      }
    }
  }, [playheadSec, clip.startSec, clip.sourceInSec]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    if (isPlaying) {
      a.play().catch(() => {});
    } else {
      a.pause();
    }
  }, [isPlaying]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.volume = volume;
    a.muted = volume <= 0;
  }, [volume]);

  return (
    <audio
      ref={ref}
      src={convertFileSrc(media.src)}
      preload="auto"
      crossOrigin="anonymous"
    />
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function StageFrame({
  aspect,
  children,
}: {
  aspect: AspectRatio;
  children: React.ReactNode;
}) {
  const [w, h] = aspect.split(":").map((n) => parseInt(n, 10));
  return (
    <div
      className="relative bg-black grid place-items-center max-h-full max-w-full overflow-hidden"
      style={{
        aspectRatio: `${w} / ${h}`,
        width: "min(100%, 1200px)",
      }}
    >
      {children}
    </div>
  );
}

function EmptyStage() {
  return (
    <div className="flex flex-col items-center gap-3 text-we-muted">
      <div className="w-14 h-14 rounded-full bg-we-panel/10 grid place-items-center">
        <span className="text-white/80 font-semibold text-lg tracking-tight">we</span>
      </div>
      <p className="text-sm">Nothing to preview</p>
    </div>
  );
}

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function collectActiveAudios(
  tracks: ReturnType<typeof useEditor.getState>["tracks"],
  clips: ReturnType<typeof useEditor.getState>["clips"],
  media: ReturnType<typeof useEditor.getState>["media"],
  playheadSec: number,
): ActiveAudio[] {
  const out: ActiveAudio[] = [];
  for (const track of tracks) {
    if (track.kind !== "audio") continue;
    if (track.muted) continue;
    for (const cid of track.clipIds) {
      const c = clips[cid];
      if (!c || c.kind === "text") continue;
      if (c.startSec <= playheadSec && playheadSec < c.startSec + c.durationSec) {
        const m = media.find((mm) => mm.id === (c as MediaClip).mediaId);
        if (!m) continue;
        out.push({
          clip: c as MediaClip,
          media: m,
          volume: clamp01((c as MediaClip).volume * track.volume),
        });
      }
    }
  }
  return out;
}

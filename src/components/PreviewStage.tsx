import { convertFileSrc } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_SCALE, MIN_SCALE, resolveTransform } from "@/lib/clips";
import { useEditor } from "@/state/editor";
import type { AspectRatio, Clip, MediaClip, MediaItem, TextClip } from "@/types";

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

  // All visible (video/image) clips active at the playhead, one per video
  // track, ordered back-to-front by zIndex. Rendering every layer (not just the
  // topmost) lets a clip's opacity reveal the layers beneath it instead of black.
  const activeVisuals = useMemo(() => {
    const ascending = [...tracks]
      .filter((t) => t.kind === "video")
      .sort((a, b) => a.zIndex - b.zIndex);
    const out: { clip: MediaClip; media: MediaItem; volume: number }[] = [];
    for (const track of ascending) {
      for (const cid of track.clipIds) {
        const c = clips[cid];
        if (!c || c.kind === "text") continue;
        if (c.startSec <= playheadSec && playheadSec < c.startSec + c.durationSec) {
          const m = media.find((mm) => mm.id === (c as MediaClip).mediaId);
          if (m) {
            const mc = c as MediaClip;
            out.push({
              clip: mc,
              media: m,
              volume: track.muted ? 0 : clamp01(mc.volume * track.volume),
            });
          }
          break; // clips can't overlap on a single track
        }
      }
    }
    return out;
  }, [tracks, clips, media, playheadSec]);

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

  const isEmpty = activeVisuals.length === 0 && activeTexts.length === 0;

  return (
    <StageFrame aspect={aspect}>
      {isEmpty && <EmptyStage />}

      {activeVisuals.map(({ clip, media: m, volume }) =>
        m.kind === "video" ? (
          <VideoLayer
            key={clip.id}
            media={m}
            clip={clip}
            playheadSec={playheadSec}
            isPlaying={isPlaying}
            volume={volume}
          />
        ) : (
          <ImageLayer key={clip.id} media={m} clip={clip} playheadSec={playheadSec} />
        ),
      )}

      {activeTexts.map((t) => (
        <TextLayer key={t.id} clip={t} playheadSec={playheadSec} />
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
      <div data-cliplayer={clip.id} style={transformStyle(resolveTransform(clip, playheadSec))}>
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
            muted={(clip.mutedTracks ?? []).includes(t.index)}
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
  muted,
  isPlaying,
  playheadSec,
  trackVolume,
}: {
  track: import("@/types").AudioTrackInfo;
  clip: MediaClip;
  muted: boolean;
  isPlaying: boolean;
  playheadSec: number;
  trackVolume: number;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const effectiveVolume = muted ? 0 : trackVolume;

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

function ImageLayer({ media, clip, playheadSec }: { media: MediaItem; clip: MediaClip; playheadSec: number }) {
  return (
    <div data-cliplayer={clip.id} style={transformStyle(resolveTransform(clip, playheadSec))}>
      <img
        src={convertFileSrc(media.src)}
        alt=""
        className="w-full h-full object-contain"
        style={{ opacity: clip.opacity }}
      />
    </div>
  );
}

function TextLayer({ clip, playheadSec }: { clip: TextClip; playheadSec: number }) {
  const tf = resolveTransform(clip, playheadSec);
  return (
    <div
      data-cliplayer={clip.id}
      className="absolute text-center"
      style={{
        left: `${tf.xPct}%`,
        top: `${tf.yPct}%`,
        transform: `translate(-50%, -50%) scale(${tf.scale})`,
        transformOrigin: "center",
        fontFamily: clip.fontFamily,
        fontSize: `${clip.fontSizePx}px`,
        color: clip.color,
        textShadow: "0 2px 12px rgba(0,0,0,0.55)",
        pointerEvents: "none",
        // Size to content (honoring explicit newlines) so positioning the text
        // near a stage edge doesn't squeeze its width and force it to re-wrap.
        whiteSpace: "pre",
        width: "max-content",
        maxWidth: "none",
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

// ── On-stage move / resize ───────────────────────────────────────────────────
//
// Overlay that lets the user drag the selected clip around the stage and resize
// it with corner handles, as an alternative to the Inspector sliders (both write
// the same xPct/yPct/scale). We measure the live layer element via its
// `data-cliplayer` attribute so the selection box hugs the real rendered bounds
// (works for both media boxes and content-sized text).

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

function StageInteraction({ stageRef }: { stageRef: React.RefObject<HTMLDivElement | null> }) {
  const clip = useEditor((s): Clip | null => {
    if (s.selectedClipIds.length !== 1) return null;
    return s.clips[s.selectedClipIds[0]] ?? null;
  });
  const playheadSec = useEditor((s) => s.playheadSec);
  const setTransformAtPlayhead = useEditor((s) => s.setTransformAtPlayhead);
  const pushHistory = useEditor((s) => s.pushHistory);

  const [box, setBox] = useState<Box | null>(null);

  // Re-measure whenever the clip (transform/text) changes, the playhead moves
  // (keyframed clips shift over time), or the stage resizes.
  const editable = clip != null && clip.kind !== "audio";
  const transformKey = clip
    ? `${clip.id}:${clip.xPct}:${clip.yPct}:${clip.scale}:${clip.keyframes?.length ?? 0}:${playheadSec.toFixed(3)}:${"fontSizePx" in clip ? clip.fontSizePx : ""}:${"text" in clip ? clip.text : ""}`
    : null;

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage || !clip || !editable) {
      setBox(null);
      return;
    }
    const measure = () => {
      const el = stage.querySelector<HTMLElement>(`[data-cliplayer="${clip.id}"]`);
      if (!el) {
        setBox(null);
        return;
      }
      const s = stage.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      setBox({ left: r.left - s.left, top: r.top - s.top, width: r.width, height: r.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [clip, editable, transformKey, stageRef]);

  if (!clip || !editable || !box) return null;

  const stageRect = () => stageRef.current?.getBoundingClientRect() ?? null;

  // Drag the whole layer → update xPct/yPct.
  const onMoveDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRect();
    if (!rect) return;
    pushHistory();
    const startX = e.clientX;
    const startY = e.clientY;
    const base = resolveTransform(clip, playheadSec);
    const baseX = base.xPct;
    const baseY = base.yPct;
    const onMove = (ev: PointerEvent) => {
      const dxPct = ((ev.clientX - startX) / rect.width) * 100;
      const dyPct = ((ev.clientY - startY) / rect.height) * 100;
      setTransformAtPlayhead(clip.id, {
        xPct: clamp(baseX + dxPct, -50, 150),
        yPct: clamp(baseY + dyPct, -50, 150),
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  // Drag a corner → scale about the layer center.
  const onResizeDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = stageRect();
    if (!rect) return;
    pushHistory();
    const cx = rect.left + box.left + box.width / 2;
    const cy = rect.top + box.top + box.height / 2;
    const startDist = Math.hypot(e.clientX - cx, e.clientY - cy) || 1;
    const baseScale = resolveTransform(clip, playheadSec).scale;
    const onMove = (ev: PointerEvent) => {
      const dist = Math.hypot(ev.clientX - cx, ev.clientY - cy);
      const next = clamp((baseScale * dist) / startDist, MIN_SCALE, MAX_SCALE);
      setTransformAtPlayhead(clip.id, { scale: next });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const handle = "absolute w-3 h-3 rounded-sm bg-we-teal border border-white shadow pointer-events-auto";
  return (
    <div
      className="absolute border-2 border-we-teal/90 cursor-move pointer-events-auto"
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
      onPointerDown={onMoveDown}
    >
      <span className={`${handle} -left-1.5 -top-1.5 cursor-nwse-resize`} onPointerDown={onResizeDown} />
      <span className={`${handle} -right-1.5 -top-1.5 cursor-nesw-resize`} onPointerDown={onResizeDown} />
      <span className={`${handle} -left-1.5 -bottom-1.5 cursor-nesw-resize`} onPointerDown={onResizeDown} />
      <span className={`${handle} -right-1.5 -bottom-1.5 cursor-nwse-resize`} onPointerDown={onResizeDown} />
    </div>
  );
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
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
  const stageRef = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={stageRef}
      className="relative bg-black grid place-items-center max-h-full max-w-full overflow-hidden"
      style={{
        aspectRatio: `${w} / ${h}`,
        width: "min(100%, 1200px)",
      }}
    >
      {children}
      <StageInteraction stageRef={stageRef} />
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

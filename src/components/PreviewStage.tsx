import { toPlayableUrl } from "@/lib/media";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { MAX_SCALE, MIN_SCALE, previousClipOnTrack, resolveTransform, type ResolvedTransform } from "@/lib/clips";
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

  // All visible (video/image) layers to draw at the playhead, back-to-front by
  // zIndex. One active clip per video track — plus, during a transition, the
  // previous clip on that track as an "outgoing" layer blended underneath the
  // incoming one. Rendering every layer (not just the topmost) also lets a
  // clip's opacity reveal the layers beneath it instead of black.
  const activeVisuals = useMemo(
    () => collectActiveVisuals(tracks, clips, media, playheadSec),
    [tracks, clips, media, playheadSec],
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

  const isEmpty = activeVisuals.length === 0 && activeTexts.length === 0;

  return (
    <StageFrame aspect={aspect}>
      {isEmpty && <EmptyStage />}

      {activeVisuals.map(({ key, clip, media: m, volume, extraOpacity, clipStyle }) =>
        m.kind === "video" ? (
          <VideoLayer
            key={key}
            media={m}
            clip={clip}
            playheadSec={playheadSec}
            isPlaying={isPlaying}
            volume={volume}
            extraOpacity={extraOpacity}
            clipStyle={clipStyle}
          />
        ) : (
          <ImageLayer
            key={key}
            media={m}
            clip={clip}
            playheadSec={playheadSec}
            extraOpacity={extraOpacity}
            clipStyle={clipStyle}
          />
        ),
      )}

      {activeTexts.map((t) => (
        <TextLayer key={t.id} clip={t} playheadSec={playheadSec} />
      ))}

      {activeAudios.map((a) => (
        <AudioLayer key={`${a.trackId}:${a.clip.id}`} {...a} isPlaying={isPlaying} playheadSec={playheadSec} />
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
  extraOpacity = 1,
  clipStyle,
}: {
  media: MediaItem;
  clip: MediaClip;
  playheadSec: number;
  isPlaying: boolean;
  volume: number;
  extraOpacity?: number;
  clipStyle?: React.CSSProperties;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const audioTracks = media.audioTracks ?? [];
  const mutedTracks = clip.mutedTracks ?? [];
  // Per-stream audio takeover: only mute the muxed <video> audio and route sound
  // through individual extracted <audio> siblings when the user has actually
  // muted at least one track. In the default case (nothing muted) the <video>
  // plays its own muxed audio — all streams already mixed — so sound never
  // depends on the extracted tracks loading/playing successfully.
  const useExtractedAudio = audioTracks.length > 0 && mutedTracks.length > 0;
  const speed = clip.speed ?? 1;
  const pitchPreserved = clip.pitchPreserved ?? true;

  // Playback speed + whether pitch follows it.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.playbackRate = speed;
    (v as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = pitchPreserved;
  }, [speed, pitchPreserved]);

  // Sync currentTime to the source position for this playhead (speed-scaled).
  // While playing, let the element run on its own clock and only correct a LARGE
  // gap (a real seek). Constantly re-seeking to the rAF playhead is what caused
  // the clip-boundary stutter, the seek-while-playing breakage, and the brief
  // "double audio" overlap. When paused (scrubbing) keep a tight sync.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const target = clip.sourceInSec + (playheadSec - clip.startSec) * speed;
    if (!Number.isFinite(target)) return;
    if (Math.abs(v.currentTime - target) > (isPlaying ? 0.5 : 0.08)) {
      try {
        v.currentTime = target;
      } catch {
        /* seek failed mid-load */
      }
      if (isPlaying) v.play().catch(() => {});
    }
  }, [playheadSec, clip.startSec, clip.sourceInSec, speed, isPlaying]);

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

  // Volume + opacity. When the user has muted a specific stream we hand audio
  // off to the extracted <audio> siblings and silence the muxed track; otherwise
  // the <video> carries the sound itself.
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    if (useExtractedAudio) {
      v.muted = true;
      v.volume = 0;
    } else {
      v.volume = volume;
      v.muted = volume <= 0;
    }
  }, [volume, useExtractedAudio]);

  return (
    <>
      <div
        data-cliplayer={clip.id}
        style={{ ...transformStyle(resolveTransform(clip, playheadSec)), ...clipStyle }}
      >
        <video
          ref={ref}
          src={toPlayableUrl(media.src)}
          playsInline
          preload="auto"
          crossOrigin="anonymous"
          className="w-full h-full object-contain"
          style={{ opacity: clip.opacity * extraOpacity }}
        />
      </div>
      {useExtractedAudio &&
        audioTracks.map((t) => (
          <ExtractedAudioTrack
            key={t.index}
            track={t}
            clip={clip}
            muted={mutedTracks.includes(t.index)}
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
  const speed = clip.speed ?? 1;
  const pitchPreserved = clip.pitchPreserved ?? true;

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.playbackRate = speed;
    (a as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = pitchPreserved;
  }, [speed, pitchPreserved]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const target = clip.sourceInSec + (playheadSec - clip.startSec) * speed;
    if (!Number.isFinite(target)) return;
    if (Math.abs(a.currentTime - target) > (isPlaying ? 0.5 : 0.08)) {
      try {
        a.currentTime = target;
      } catch {
        /* seek failed mid-load */
      }
      if (isPlaying) a.play().catch(() => {});
    }
  }, [playheadSec, clip.startSec, clip.sourceInSec, speed, isPlaying]);

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
      src={toPlayableUrl(track.filepath)}
      preload="auto"
      crossOrigin="anonymous"
    />
  );
}

function ImageLayer({
  media,
  clip,
  playheadSec,
  extraOpacity = 1,
  clipStyle,
}: {
  media: MediaItem;
  clip: MediaClip;
  playheadSec: number;
  extraOpacity?: number;
  clipStyle?: React.CSSProperties;
}) {
  return (
    <div
      data-cliplayer={clip.id}
      style={{ ...transformStyle(resolveTransform(clip, playheadSec)), ...clipStyle }}
    >
      <img
        src={toPlayableUrl(media.src)}
        alt=""
        className="w-full h-full object-contain"
        style={{ opacity: clip.opacity * extraOpacity }}
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
        transform: `perspective(1200px) translate(-50%, -50%) rotateX(${tf.tilt}deg) rotateZ(${tf.rotation}deg) scale(${tf.scale})`,
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

// Absolute, stage-sized box centered on (xPct,yPct), scaled, rotated and tilted.
// Media fills it with object-contain, so the default 50/50/scale-1/0°/0° overlays
// the whole stage exactly as before; changing the transform moves/zooms/rotates.
function transformStyle(t: ResolvedTransform): React.CSSProperties {
  return {
    position: "absolute",
    left: `${t.xPct}%`,
    top: `${t.yPct}%`,
    width: "100%",
    height: "100%",
    transform: `perspective(1200px) translate(-50%, -50%) rotateX(${t.tilt}deg) rotateZ(${t.rotation}deg) scale(${t.scale})`,
    transformOrigin: "center",
  };
}

interface ActiveAudio {
  trackId: string;
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
  const speed = clip.speed ?? 1;
  const pitchPreserved = clip.pitchPreserved ?? true;

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.playbackRate = speed;
    (a as HTMLMediaElement & { preservesPitch?: boolean }).preservesPitch = pitchPreserved;
  }, [speed, pitchPreserved]);

  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    const target = clip.sourceInSec + (playheadSec - clip.startSec) * speed;
    if (!Number.isFinite(target)) return;
    if (Math.abs(a.currentTime - target) > (isPlaying ? 0.5 : 0.08)) {
      try {
        a.currentTime = target;
      } catch {
        /* seek failed mid-load */
      }
      if (isPlaying) a.play().catch(() => {});
    }
  }, [playheadSec, clip.startSec, clip.sourceInSec, speed, isPlaying]);

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
      src={toPlayableUrl(media.src)}
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
      className="relative bg-black grid place-items-center overflow-hidden"
      // Fit-to-area: take the largest w×h that fits the size-container parent
      // while preserving aspect. One axis maxes out, the other is derived — so
      // tall (9:16) or wide (21:9) frames always scale fully inside the preview.
      style={{
        aspectRatio: `${w} / ${h}`,
        width: `min(100cqw, calc(100cqh * ${w} / ${h}))`,
        height: `min(100cqh, calc(100cqw * ${h} / ${w}))`,
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

interface VisualEntry {
  key: string;
  clip: MediaClip;
  media: MediaItem;
  volume: number;
  /** Multiplies clip.opacity (crossfade ramp). */
  extraOpacity: number;
  /** Extra style on the layer box (e.g. wipe clip-path). */
  clipStyle?: React.CSSProperties;
}

// One active visual layer per video track, plus the previous clip as an
// "outgoing" layer during a transition (blended under the incoming one).
function collectActiveVisuals(
  tracks: ReturnType<typeof useEditor.getState>["tracks"],
  clips: ReturnType<typeof useEditor.getState>["clips"],
  media: ReturnType<typeof useEditor.getState>["media"],
  playheadSec: number,
): VisualEntry[] {
  const ascending = [...tracks]
    .filter((t) => t.kind === "video")
    .sort((a, b) => a.zIndex - b.zIndex);
  const out: VisualEntry[] = [];

  for (const track of ascending) {
    let active: MediaClip | null = null;
    for (const cid of track.clipIds) {
      const c = clips[cid];
      if (!c || c.kind === "text") continue;
      if (c.startSec <= playheadSec && playheadSec < c.startSec + c.durationSec) {
        active = c as MediaClip;
        break;
      }
    }
    if (!active) continue;
    const mActive = media.find((m) => m.id === active!.mediaId);
    if (!mActive) continue;
    const vol = (c: MediaClip) => (track.muted ? 0 : clamp01(c.volume * track.volume));

    const tr = active.transition;
    const local = playheadSec - active.startSec;
    if (tr && tr.durationSec > 0 && local >= 0 && local < tr.durationSec) {
      const prev = previousClipOnTrack(clips, active);
      const mPrev = prev && prev.kind !== "text" ? media.find((m) => m.id === (prev as MediaClip).mediaId) : null;
      if (prev && mPrev) {
        const p = local / tr.durationSec; // incoming progress 0..1
        // Outgoing (behind): the previous clip's source keeps playing past its
        // cut into the lead-in window, fading out.
        out.push({
          key: `${track.id}-out`,
          clip: prev as MediaClip,
          media: mPrev,
          volume: vol(prev as MediaClip) * (1 - p),
          extraOpacity: 1 - p,
        });
        // Incoming (front): crossfade ramps opacity; wipe reveals left→right.
        out.push({
          key: `${track.id}:${active.mediaId}`,
          clip: active,
          media: mActive,
          volume: vol(active) * p,
          extraOpacity: tr.type === "crossfade" ? p : 1,
          clipStyle: tr.type === "wipe" ? { clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` } : undefined,
        });
        continue;
      }
    }

    out.push({
      key: `${track.id}:${active.mediaId}`,
      clip: active,
      media: mActive,
      volume: vol(active),
      extraOpacity: 1,
    });
  }
  return out;
}

function collectActiveAudios(
  tracks: ReturnType<typeof useEditor.getState>["tracks"],
  clips: ReturnType<typeof useEditor.getState>["clips"],
  media: ReturnType<typeof useEditor.getState>["media"],
  playheadSec: number,
): ActiveAudio[] {
  const out: ActiveAudio[] = [];
  for (const track of tracks) {
    // Collect audio from dedicated audio tracks AND from video tracks that have
    // had their audio detached (kind === "audio" clips sitting on a video track).
    // Previously this skipped all non-"audio" tracks, silencing detached audio.
    if (track.kind !== "audio" && track.kind !== "video") continue;
    if (track.muted) continue;
    for (const cid of track.clipIds) {
      const c = clips[cid];
      // Only process audio-kind clips here; video clips handle their own audio
      // via the <video> element (or ExtractedAudioTrack for multi-stream).
      if (!c || c.kind !== "audio") continue;
      if (c.startSec <= playheadSec && playheadSec < c.startSec + c.durationSec) {
        const m = media.find((mm) => mm.id === (c as MediaClip).mediaId);
        if (!m) continue;
        out.push({
          trackId: track.id,
          clip: c as MediaClip,
          media: m,
          volume: clamp01((c as MediaClip).volume * track.volume),
        });
      }
    }
  }
  return out;
}

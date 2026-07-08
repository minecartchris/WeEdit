// Compiles the current editor state into an ffmpeg argv array that produces
// the rendered timeline as an mp4. The output is one big `-filter_complex`
// graph: video clips composited in z-order on a black canvas, text overlays
// drawn on top via `drawtext`, audio mixed via `amix`. Multi-track video
// audio respects per-media mute state.
//
// All `-i` inputs are added once per unique source path (videos, image files,
// audio files, and extracted per-stream audio for multi-track video media).

import type {
  AudioTrackInfo,
  Clip,
  MediaClip,
  MediaItem,
  ProjectMeta,
  TextClip,
  Track,
} from "@/types";

export type VideoCodec = "h264_nvenc" | "libx264";

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  videoCodec: VideoCodec;
  /** Constant-quality target (CQ for NVENC, CRF for libx264). Lower = better. */
  cq: number;
  audioBitrateKbps: number;
  outputPath: string;
}

export interface CompiledExport {
  args: string[];
  totalDurationSec: number;
}

export interface ExportInputs {
  project: ProjectMeta;
  tracks: Track[];
  clips: Record<string, Clip>;
  media: MediaItem[];
}

const MIN_ENCODABLE_DUR = 0.05;

export function compileExport(input: ExportInputs, opts: ExportOptions): CompiledExport {
  const { project, tracks, clips, media } = input;

  const totalDur = computeTotalDuration(clips);
  if (totalDur < MIN_ENCODABLE_DUR) {
    throw new Error("Timeline is empty — drop a clip onto a track first.");
  }

  // ── 1. Collect inputs. Each unique source path becomes one `-i`. ──
  const inputPaths: string[] = [];
  const mediaSrcInput = new Map<string, number>(); // mediaId → -i index (the video / image / audio file)
  const audioTrackInput = new Map<string, number>(); // `${mediaId}:${trackIndex}` → -i index

  const ensureSrcInput = (m: MediaItem) => {
    if (mediaSrcInput.has(m.id)) return;
    mediaSrcInput.set(m.id, inputPaths.length);
    inputPaths.push(m.src);
  };
  const ensureTrackInput = (m: MediaItem, t: AudioTrackInfo) => {
    const key = `${m.id}:${t.index}`;
    if (audioTrackInput.has(key)) return;
    audioTrackInput.set(key, inputPaths.length);
    inputPaths.push(t.filepath);
  };

  for (const c of Object.values(clips)) {
    if (c.kind === "text") continue;
    const mc = c as MediaClip;
    const m = media.find((mm) => mm.id === mc.mediaId);
    if (!m) continue;
    ensureSrcInput(m);
    if (m.kind === "video" && m.audioTracks && m.audioTracks.length > 0) {
      for (const t of m.audioTracks) if (!t.muted) ensureTrackInput(m, t);
    }
  }

  // ── 2. Video composite. ──
  const parts: string[] = [];
  parts.push(
    `color=c=black:s=${opts.width}x${opts.height}:d=${totalDur.toFixed(3)}:r=${opts.fps}[bg0]`,
  );

  const videoClips = collectVideoClipsByZOrder(tracks, clips, media);
  let bgLabel = "bg0";
  let vCounter = 0;
  for (const { clip, media: m } of videoClips) {
    const inputIdx = mediaSrcInput.get(m.id);
    if (inputIdx === undefined) continue;
    const inLabel = `[${inputIdx}:v]`;
    const prepared = `vp${vCounter++}`;

    // Speed: grab `durationSec * speed` of source, then setpts/speed compresses
    // (or stretches) it to occupy durationSec on the timeline. Images ignore it.
    const speed = m.kind === "image" ? 1 : clip.speed ?? 1;
    const sourceSpan = clip.durationSec * speed;
    const head =
      m.kind === "image"
        ? `${inLabel}loop=loop=-1:size=1,trim=duration=${clip.durationSec.toFixed(3)}`
        : `${inLabel}trim=start=${clip.sourceInSec.toFixed(3)}:duration=${sourceSpan.toFixed(3)}`;

    // Crop trims a percentage off each edge of the *source* frame before the
    // aspect-fit scale below, matching the preview's clip-path (which trims the
    // same percentage off the rendered, already-fit box — equivalent since the
    // fit is a uniform scale). Skipped entirely when there's no crop so the
    // filter graph for uncropped clips (the vast majority) is unchanged.
    const cropFilter = cropFilterFor(clip.crop);

    // On-stage position/zoom/rotation. The preview positions a stage-sized box
    // at (xPct,yPct) with translate(-50%,-50%), then scales/rotates it about
    // its own center — reproduced here as: pad to canvas size (a stage-sized
    // box at the default position), zoom by resizing that whole box, rotate it
    // (transparent fill so corners stay see-through), then let `overlay`'s x/y
    // expressions center the (possibly resized) box at (xPct%, yPct%) of the
    // canvas. Keyframed animation isn't carried into the export — this uses
    // each clip's base (non-keyframed) transform, same as the export's
    // pre-existing (and still unanimated) handling of text position.
    const scale = clip.scale ?? 1;
    const rotationDeg = clip.rotation ?? 0;
    const zoomFilter = Math.abs(scale - 1) > 1e-3 ? `,scale=iw*${scale.toFixed(4)}:ih*${scale.toFixed(4)}` : "";
    const rotationRad = (rotationDeg * Math.PI) / 180;
    const rotateFilter =
      Math.abs(rotationDeg) > 1e-3
        ? `,rotate=${rotationRad.toFixed(6)}:c=black@0:ow=rotw(${rotationRad.toFixed(6)}):oh=roth(${rotationRad.toFixed(6)})`
        : "";
    const xPct = clip.xPct ?? 50;
    const yPct = clip.yPct ?? 50;
    const overlayX = `(main_w*${(xPct / 100).toFixed(4)})-(overlay_w/2)`;
    const overlayY = `(main_h*${(yPct / 100).toFixed(4)})-(overlay_h/2)`;

    parts.push(
      `${head}${cropFilter ? `,${cropFilter}` : ""},setpts=(PTS-STARTPTS)/${speed.toFixed(6)},` +
        `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,` +
        `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:color=black@0,` +
        `format=yuva420p,` +
        `colorchannelmixer=aa=${clip.opacity.toFixed(3)}` +
        `${zoomFilter}${rotateFilter},` +
        `setpts=PTS+${clip.startSec.toFixed(3)}/TB` +
        `[${prepared}]`,
    );

    const nextBg = `bg${vCounter}`;
    parts.push(
      `[${bgLabel}][${prepared}]overlay=x='${overlayX}':y='${overlayY}':enable='between(t,${clip.startSec.toFixed(3)},${(clip.startSec + clip.durationSec).toFixed(3)})'[${nextBg}]`,
    );
    bgLabel = nextBg;
  }

  // ── 3. Text overlays drawn on top of the video composite. ──
  const textClips: TextClip[] = (Object.values(clips).filter((c) => c.kind === "text") as TextClip[]).sort(
    (a, b) => a.startSec - b.startSec,
  );
  let lastVideoLabel = bgLabel;
  textClips.forEach((tc, i) => {
    const text = escapeDrawText(tc.text || " ");
    const colorArg = `${tc.color.replace(/^#/, "0x")}`;
    const xExpr = `(w*${(tc.xPct / 100).toFixed(4)})-text_w/2`;
    const yExpr = `(h*${(tc.yPct / 100).toFixed(4)})-text_h/2`;
    // Zoom applies to text the same way it does to video/image clips (a
    // multiplier on rendered size). Rotation/tilt aren't supported for text —
    // ffmpeg's drawtext filter has no rotation parameter — so they're left
    // out of the export for now (this matches drawtext's own limitation, not
    // an oversight for video/image clips above).
    const fontsize = Math.max(
      8,
      Math.round(tc.fontSizePx * (opts.height / Math.max(1, project.height)) * (tc.scale ?? 1)),
    );
    const fontPath = fontPathFor(tc.fontFamily);
    const newLabel = `txt${i + 1}`;
    parts.push(
      `[${lastVideoLabel}]drawtext=fontfile='${fontPath}':text='${text}':expansion=none:x='${xExpr}':y='${yExpr}':fontsize=${fontsize}:fontcolor=${colorArg}:shadowx=2:shadowy=2:shadowcolor=black@0.6:enable='between(t,${tc.startSec.toFixed(3)},${(tc.startSec + tc.durationSec).toFixed(3)})'[${newLabel}]`,
    );
    lastVideoLabel = newLabel;
  });

  // ── 4. Audio mix. ──
  const audioOutLabel = compileAudio({
    tracks,
    clips,
    media,
    parts,
    mediaSrcInput,
    audioTrackInput,
  });

  // ── 5. Codec + container args. ──
  const videoCodecArgs =
    opts.videoCodec === "h264_nvenc"
      ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc:v", "vbr", "-cq:v", String(opts.cq), "-b:v", "0"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", String(opts.cq)];

  const audioCodecArgs = ["-c:a", "aac", "-b:a", `${opts.audioBitrateKbps}k`];

  const args: string[] = [];
  for (const path of inputPaths) {
    args.push("-i", path);
  }
  args.push("-filter_complex", parts.join(";"));
  args.push("-map", `[${lastVideoLabel}]`);
  if (audioOutLabel) {
    args.push("-map", audioOutLabel);
    args.push(...audioCodecArgs);
  } else {
    args.push("-an");
  }
  args.push(...videoCodecArgs);
  args.push("-r", String(opts.fps));
  args.push("-pix_fmt", "yuv420p");
  args.push("-movflags", "+faststart");
  args.push("-y", opts.outputPath);

  return { args, totalDurationSec: totalDur };
}

// ── Audio compiler ──

interface AudioCompileCtx {
  tracks: Track[];
  clips: Record<string, Clip>;
  media: MediaItem[];
  parts: string[];
  mediaSrcInput: Map<string, number>;
  audioTrackInput: Map<string, number>;
}

function compileAudio(ctx: AudioCompileCtx): string | null {
  const { tracks, clips, media, parts, mediaSrcInput, audioTrackInput } = ctx;
  const audioOutLabels: string[] = [];
  let counter = 0;
  const next = (p: string) => `${p}${counter++}`;

  for (const c of Object.values(clips)) {
    if (c.kind === "text") continue;
    const mc = c as MediaClip;
    const m = media.find((mm) => mm.id === mc.mediaId);
    if (!m) continue;

    const track = tracks.find((t) => t.id === mc.trackId);
    if (track?.muted) continue;
    const effVolume = mc.volume * (track?.volume ?? 1);
    if (effVolume <= 0) continue;

    const delayMs = Math.max(0, Math.round(mc.startSec * 1000));
    const adelay = `adelay=${delayMs}|${delayMs}`;
    // Speed: trim `durationSec * speed` of source, then retime to durationSec.
    // Pitch preserved → atempo (sample-rate agnostic); pitch follows → asetrate
    // (tape effect; assumes 48 kHz, the norm for screen/Twitch captures).
    const speed = mc.speed ?? 1;
    const pitchPreserved = mc.pitchPreserved ?? true;
    const speedFilter =
      speed === 1
        ? ""
        : pitchPreserved
        ? atempoChain(speed)
        : `asetrate=${Math.round(48000 * speed)},aresample=48000`;
    const trim =
      `atrim=start=${mc.sourceInSec.toFixed(3)}:duration=${(mc.durationSec * speed).toFixed(3)},asetpts=PTS-STARTPTS` +
      (speedFilter ? `,${speedFilter}` : "");
    const volume = `volume=${effVolume.toFixed(3)}`;

    if (m.kind === "image") continue;

    if (m.kind === "audio") {
      const inputIdx = mediaSrcInput.get(m.id);
      if (inputIdx === undefined) continue;
      const out = next("ac");
      parts.push(`[${inputIdx}:a]${trim},${adelay},${volume}[${out}]`);
      audioOutLabels.push(`[${out}]`);
      continue;
    }

    // m.kind === "video"
    if (m.audioTracks && m.audioTracks.length > 0) {
      const live = m.audioTracks.filter((t) => !t.muted);
      if (live.length === 0) continue; // all tracks muted on this media

      const perTrack: string[] = [];
      for (const t of live) {
        const inputIdx = audioTrackInput.get(`${m.id}:${t.index}`);
        if (inputIdx === undefined) continue;
        const trimmed = next("at");
        parts.push(`[${inputIdx}:a]${trim}[${trimmed}]`);
        perTrack.push(`[${trimmed}]`);
      }
      if (perTrack.length === 0) continue;

      let mixedLabel: string;
      if (perTrack.length === 1) {
        // unwrap the [name] label so we can pass it directly into the next stage
        mixedLabel = perTrack[0].slice(1, -1);
      } else {
        mixedLabel = next("am");
        parts.push(
          `${perTrack.join("")}amix=inputs=${perTrack.length}:duration=longest:normalize=0[${mixedLabel}]`,
        );
      }
      const out = next("af");
      parts.push(`[${mixedLabel}]${adelay},${volume}[${out}]`);
      audioOutLabels.push(`[${out}]`);
    } else {
      // Single-track muxed audio from the video file itself
      const inputIdx = mediaSrcInput.get(m.id);
      if (inputIdx === undefined) continue;
      const out = next("ac");
      parts.push(`[${inputIdx}:a]${trim},${adelay},${volume}[${out}]`);
      audioOutLabels.push(`[${out}]`);
    }
  }

  if (audioOutLabels.length === 0) return null;
  if (audioOutLabels.length === 1) return audioOutLabels[0];

  const finalLabel = "aout";
  parts.push(
    `${audioOutLabels.join("")}amix=inputs=${audioOutLabels.length}:duration=longest:normalize=0[${finalLabel}]`,
  );
  return `[${finalLabel}]`;
}

// ── Helpers ──

// Builds the `crop=w:h:x:y` filter for a clip's crop percentages, or null when
// there's no crop (so callers can skip the comma-separated segment entirely).
// Percentages are trimmed off each edge of the *source* frame; each pair is
// clamped so the remaining width/height never hits zero (or goes negative),
// which ffmpeg would reject.
function cropFilterFor(crop: MediaClip["crop"] | undefined): string | null {
  if (!crop) return null;
  const clampPct = (v: number) => Math.max(0, Math.min(99, v || 0));
  let left = clampPct(crop.left);
  let right = clampPct(crop.right);
  let top = clampPct(crop.top);
  let bottom = clampPct(crop.bottom);
  if (left + right >= 100) {
    const scale = 99 / (left + right);
    left *= scale;
    right *= scale;
  }
  if (top + bottom >= 100) {
    const scale = 99 / (top + bottom);
    top *= scale;
    bottom *= scale;
  }
  if (left === 0 && right === 0 && top === 0 && bottom === 0) return null;
  const w = (1 - (left + right) / 100).toFixed(4);
  const h = (1 - (top + bottom) / 100).toFixed(4);
  const x = (left / 100).toFixed(4);
  const y = (top / 100).toFixed(4);
  return `crop=iw*${w}:ih*${h}:iw*${x}:ih*${y}`;
}

// atempo only accepts factors in [0.5, 2.0]; chain it to reach any speed while
// preserving pitch (e.g. 4× = atempo=2,atempo=2; 0.25× = atempo=0.5,atempo=0.5).
function atempoChain(speed: number): string {
  let s = speed;
  const parts: string[] = [];
  while (s > 2.0 + 1e-9) {
    parts.push("atempo=2.0");
    s /= 2.0;
  }
  while (s < 0.5 - 1e-9) {
    parts.push("atempo=0.5");
    s /= 0.5;
  }
  parts.push(`atempo=${s.toFixed(6)}`);
  return parts.join(",");
}

function computeTotalDuration(clips: Record<string, Clip>): number {
  let max = 0;
  for (const c of Object.values(clips)) {
    const end = c.startSec + c.durationSec;
    if (end > max) max = end;
  }
  return max;
}

interface OrderedVideoClip {
  clip: MediaClip;
  media: MediaItem;
}

function collectVideoClipsByZOrder(
  tracks: Track[],
  clips: Record<string, Clip>,
  media: MediaItem[],
): OrderedVideoClip[] {
  // Lower zIndex = drawn first (bottom). Then within a track, earlier-start first.
  const videoTracks = tracks.filter((t) => t.kind === "video").sort((a, b) => a.zIndex - b.zIndex);
  const out: OrderedVideoClip[] = [];
  for (const tr of videoTracks) {
    const ordered = tr.clipIds
      .map((id) => clips[id])
      .filter((c): c is Clip => Boolean(c) && c.kind !== "text" && c.kind !== "audio")
      .sort((a, b) => a.startSec - b.startSec);
    for (const c of ordered) {
      const mc = c as MediaClip;
      const m = media.find((mm) => mm.id === mc.mediaId);
      if (!m) continue;
      out.push({ clip: mc, media: m });
    }
  }
  return out;
}

// Escape user text for a drawtext `text='...'` value. The value sits inside a
// graph-level single-quoted string and the filter carries `:expansion=none`.
// All rules verified against the bundled ffmpeg 8.1:
//   \  → \\   drawtext strips one backslash level.
//   '  → ’    A literal ASCII apostrophe CANNOT survive inside a single-quoted
//             drawtext value: no escaping renders it — it either closes the
//             quote (corrupting quote parity for the *rest* of the graph, so a
//             later `enable='between(t,49.758,…)'` loses its quotes and ffmpeg
//             reads `49.758` as a filter name → "No such filter"), or draws
//             nothing. So map it to a typographic apostrophe, which renders.
//   :  → \:   colon separates filter options even inside single quotes.
//   %  → \%   percent begins a %{…} expansion; escape it (needs expansion=none).
//   newline → a real "\n"; drawtext renders it as a line break.
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/'/g, "’")
    .replace(/:/g, "\\:")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, "\n");
}

// Maps our font-family CSS strings to absolute Windows font paths. drawtext
// can't parse CSS family stacks; it wants a `fontfile=` path. The colon in
// `C:` needs to be escaped inside a filter argument.
function fontPathFor(family: string): string {
  const f = (family || "").toLowerCase();
  let file: string;
  if (f.includes("impact")) file = "impact.ttf";
  else if (f.includes("comic")) file = "comic.ttf";
  else if (f.includes("trebuc")) file = "trebuc.ttf";
  else if (f.includes("times")) file = "times.ttf";
  else if (f.includes("georgia")) file = "georgia.ttf";
  else if (f.includes("courier")) file = "cour.ttf";
  else file = "arial.ttf"; // Inter / Helvetica / system → Arial fallback
  return `C\\:/Windows/Fonts/${file}`;
}

// ── Preset library ──

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  cq: number;
  audioBitrateKbps: number;
}

export const EXPORT_PRESETS: ExportPreset[] = [
  { id: "1080p60", label: "1080p · 60 fps", width: 1920, height: 1080, fps: 60, cq: 21, audioBitrateKbps: 192 },
  { id: "1080p30", label: "1080p · 30 fps", width: 1920, height: 1080, fps: 30, cq: 21, audioBitrateKbps: 192 },
  { id: "shorts60", label: "Shorts 9:16 · 60 fps", width: 1080, height: 1920, fps: 60, cq: 21, audioBitrateKbps: 192 },
  { id: "shorts30", label: "Shorts 9:16 · 30 fps", width: 1080, height: 1920, fps: 30, cq: 21, audioBitrateKbps: 192 },
  { id: "720p60",  label: "720p · 60 fps",  width: 1280, height: 720,  fps: 60, cq: 22, audioBitrateKbps: 160 },
  { id: "720p30",  label: "720p · 30 fps",  width: 1280, height: 720,  fps: 30, cq: 22, audioBitrateKbps: 160 },
];

export function defaultPresetForAspect(aspect: ProjectMeta["aspectRatio"]): ExportPreset {
  // 16:9 → 1920x1080; 9:16 → 1080x1920; etc. For now we just use 1080p30 for 16:9
  // and let the user adjust dimensions in Custom for other aspects.
  if (aspect === "9:16") {
    return { id: "9x16-1080p30", label: "1080×1920 · 30 fps", width: 1080, height: 1920, fps: 30, cq: 21, audioBitrateKbps: 192 };
  }
  if (aspect === "1:1") {
    return { id: "1x1-1080p30", label: "1080×1080 · 30 fps", width: 1080, height: 1080, fps: 30, cq: 21, audioBitrateKbps: 192 };
  }
  return EXPORT_PRESETS[1]; // 1080p30
}

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

    // Crop / position / scale / rotation, matching the preview's box model so the
    // exported frame lines up with what the editor shows (split-screen overlays).
    const tf = videoTransformFilters(clip, opts.width, opts.height);

    parts.push(
      `${head},setpts=(PTS-STARTPTS)/${speed.toFixed(6)},` +
        tf.chain +
        `setpts=PTS+${clip.startSec.toFixed(3)}/TB,` +
        `format=yuva420p,` +
        `colorchannelmixer=aa=${clip.opacity.toFixed(3)}` +
        `[${prepared}]`,
    );

    const nextBg = `bg${vCounter}`;
    parts.push(
      `[${bgLabel}][${prepared}]overlay=x=${tf.x}:y=${tf.y}:enable='between(t,${clip.startSec.toFixed(3)},${(clip.startSec + clip.durationSec).toFixed(3)})'[${nextBg}]`,
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
    const fontsize = Math.max(
      8,
      Math.round(tc.fontSizePx * (opts.height / Math.max(1, project.height))),
    );
    const fontPath = fontPathFor(tc.fontFamily);
    const newLabel = `txt${i + 1}`;
    parts.push(
      `[${lastVideoLabel}]drawtext=fontfile='${fontPath}':text='${text}':x='${xExpr}':y='${yExpr}':fontsize=${fontsize}:fontcolor=${colorArg}:shadowx=2:shadowy=2:shadowcolor=black@0.6:enable='between(t,${tc.startSec.toFixed(3)},${(tc.startSec + tc.durationSec).toFixed(3)})'[${newLabel}]`,
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

function clampf(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Builds the per-clip video filter chain + overlay position so the export
 * matches the preview's transform model:
 *   - the source is object-contain fit into a W×H "box" (the full canvas),
 *   - the box is cropped by the inset fractions (clip.crop),
 *   - then scaled by clip.scale and centred at (clip.xPct, clip.yPct),
 *   - then rotated by clip.rotation.
 * Cropping a clip to one half and dropping two copies side-by-side therefore
 * exports as a real split-screen, exactly as the editor renders it.
 *
 * Note: 3-D `tilt` (perspective rotateX) and keyframed transforms aren't carried
 * into the export — only the clip's static transform is rendered.
 */
function videoTransformFilters(
  clip: MediaClip,
  W: number,
  H: number,
): { chain: string; x: number; y: number } {
  const cr = clip.crop;
  const l = cr ? clampf(cr.left, 0, 0.99) : 0;
  const t = cr ? clampf(cr.top, 0, 0.99) : 0;
  const r = cr ? clampf(cr.right, 0, 0.99 - l) : 0;
  const b = cr ? clampf(cr.bottom, 0, 0.99 - t) : 0;
  const s = clip.scale ?? 1;
  const rot = clip.rotation ?? 0;
  const xPct = clip.xPct ?? 50;
  const yPct = clip.yPct ?? 50;

  const cropped = l > 0 || r > 0 || t > 0 || b > 0;
  const transformed = cropped || s !== 1 || rot !== 0 || xPct !== 50 || yPct !== 50;

  // The fit-and-centre base, identical to the original (untransformed) output so
  // plain clips export byte-for-byte as before.
  const fitPad =
    `scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black@0,`;

  if (!transformed) {
    return { chain: fitPad, x: 0, y: 0 };
  }

  // Box (the W×H stage) → crop inset → scale by s. Centre of the visible region
  // tracks where the inset sits within the box (so cropping alone shifts it,
  // matching the CSS clip-path preview).
  const boxW = W * (1 - l - r) * s;
  const boxH = H * (1 - t - b) * s;
  const cx = (xPct / 100) * W + s * ((l - r) / 2) * W;
  const cy = (yPct / 100) * H + s * ((t - b) / 2) * H;

  let chain = fitPad;
  if (cropped) {
    chain +=
      `crop=${(W * (1 - l - r)).toFixed(2)}:${(H * (1 - t - b)).toFixed(2)}:` +
      `${(W * l).toFixed(2)}:${(H * t).toFixed(2)},`;
  }
  chain += `scale=${Math.max(2, Math.round(boxW))}:${Math.max(2, Math.round(boxH))},`;

  let finalW = boxW;
  let finalH = boxH;
  if (rot !== 0) {
    const rad = (rot * Math.PI) / 180;
    const ow = Math.abs(boxW * Math.cos(rad)) + Math.abs(boxH * Math.sin(rad));
    const oh = Math.abs(boxW * Math.sin(rad)) + Math.abs(boxH * Math.cos(rad));
    chain += `rotate=${rad.toFixed(6)}:ow=${Math.ceil(ow)}:oh=${Math.ceil(oh)}:c=black@0,`;
    finalW = ow;
    finalH = oh;
  }

  return {
    chain,
    x: Math.round(cx - finalW / 2),
    y: Math.round(cy - finalH / 2),
  };
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

// ffmpeg drawtext text escaping: backslash, single quote, and colon all need
// escaping so they don't terminate the filter argument or break the parser.
function escapeDrawText(text: string): string {
  return text
    .replace(/\\/g, "\\\\\\\\")
    .replace(/'/g, "\\\\\\'")
    .replace(/:/g, "\\\\:")
    .replace(/%/g, "\\%")
    .replace(/\r?\n/g, "\\n");
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

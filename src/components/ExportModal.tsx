import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog, open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { documentDir, join } from "@tauri-apps/api/path";
import {
  AlertTriangle,
  Check,
  CircleSlash,
  Cpu,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import {
  EXPORT_PRESETS,
  defaultPresetForAspect,
  type ExportPreset,
  type VideoCodec,
} from "@/lib/exportFfmpeg";
import { checkFfmpeg, checkNvenc, type FfmpegCheck } from "@/lib/ffmpeg";
import { useEditor } from "@/state/editor";
import { useExports } from "@/state/exports";
import { useIntegrations } from "@/state/integrations";

interface Props {
  open: boolean;
  onClose: () => void;
}

type PresetId =
  | "1080p60"
  | "1080p30"
  | "shorts60"
  | "shorts30"
  | "720p60"
  | "720p30"
  | "custom"
  | "aspect-default";

export function ExportModal({ open, onClose }: Props) {
  const projectName = useEditor((s) => s.project.name);
  const projectPath = useEditor((s) => s.projectPath);
  const aspect = useEditor((s) => s.project.aspectRatio);
  const clipCount = useEditor((s) => Object.keys(s.clips).length);
  const active = useExports((s) => s.active);
  const startExport = useExports((s) => s.start);
  const cancelExport = useExports((s) => s.cancel);
  const dismissExport = useExports((s) => s.dismiss);
  const ffmpegPath = useIntegrations((s) => s.ffmpegPath);
  const setFfmpegPath = useIntegrations((s) => s.setFfmpegPath);

  const [ffmpegStatus, setFfmpegStatus] = useState<FfmpegCheck | null>(null);
  const recheckFfmpeg = useCallback(async () => {
    setFfmpegStatus(await checkFfmpeg());
  }, []);
  useEffect(() => {
    if (!open) return;
    void recheckFfmpeg();
  }, [open, ffmpegPath, recheckFfmpeg]);

  // NVENC was previously the hardcoded default encoder for every preset
  // (including Custom), so on any machine without a working NVIDIA
  // GPU/driver, every export failed identically no matter what the user
  // picked. Probe for real NVENC support and fall back to the CPU encoder
  // when it's not available — but only if the user hasn't already made an
  // explicit choice, so we never override a deliberate selection.
  const [nvencAvailable, setNvencAvailable] = useState<boolean | null>(null);
  const codecTouchedRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    void (async () => {
      const available = await checkNvenc();
      setNvencAvailable(available);
      if (!available && !codecTouchedRef.current) {
        setCodec("libx264");
      }
    })();
  }, [open, ffmpegPath]);

  const locateFfmpeg = async () => {
    const picked = await openDialog({
      title: "Locate ffmpeg.exe",
      filters: [{ name: "Executable", extensions: ["exe"] }],
      multiple: false,
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) await setFfmpegPath(path);
  };

  const aspectDefault = useMemo(() => defaultPresetForAspect(aspect), [aspect]);

  const [presetId, setPresetId] = useState<PresetId>("1080p30");
  const [customWidth, setCustomWidth] = useState(1920);
  const [customHeight, setCustomHeight] = useState(1080);
  const [customFps, setCustomFps] = useState(30);
  const [cq, setCq] = useState(21);
  const [audioBitrate, setAudioBitrate] = useState(192);
  const [codec, setCodec] = useState<VideoCodec>("h264_nvenc");
  const [outputPath, setOutputPath] = useState<string>("");
  const [resolvingPath, setResolvingPath] = useState(false);

  // Pick a default output path the first time the modal opens.
  useEffect(() => {
    if (!open || outputPath) return;
    setResolvingPath(true);
    void (async () => {
      try {
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const filename = `${projectName.replace(/[\\/:*?"<>|]/g, "_")}_${ts}.mp4`;
        if (projectPath) {
          setOutputPath(`${projectPath.replace(/\\/g, "/")}/exports/${filename}`);
        } else {
          const docs = await documentDir();
          setOutputPath(await join(docs, "WeEdit Exports", filename));
        }
      } finally {
        setResolvingPath(false);
      }
    })();
  }, [open, outputPath, projectName, projectPath]);

  const isCustom = presetId === "custom";
  const isAspectDefault = presetId === "aspect-default";

  const resolved = useMemo(() => {
    if (isCustom) {
      return { width: customWidth, height: customHeight, fps: customFps, cq, audioBitrateKbps: audioBitrate };
    }
    let p: ExportPreset;
    if (isAspectDefault) {
      p = aspectDefault;
    } else {
      p = EXPORT_PRESETS.find((x) => x.id === presetId) ?? EXPORT_PRESETS[1];
    }
    return { width: p.width, height: p.height, fps: p.fps, cq: p.cq, audioBitrateKbps: p.audioBitrateKbps };
  }, [presetId, isCustom, isAspectDefault, customWidth, customHeight, customFps, cq, audioBitrate, aspectDefault]);

  const canExport = clipCount > 0 && !!outputPath.trim() && (!active || active.status === "complete" || active.status === "error" || active.status === "cancelled");

  const onStart = async () => {
    await startExport({
      width: resolved.width,
      height: resolved.height,
      fps: resolved.fps,
      cq: resolved.cq,
      audioBitrateKbps: resolved.audioBitrateKbps,
      videoCodec: codec,
      outputPath: outputPath.trim(),
    });
  };

  const onBrowse = async () => {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const defaultName = `${projectName.replace(/[\\/:*?"<>|]/g, "_")}_${ts}.mp4`;
    const picked = await saveDialog({
      title: "Export to…",
      defaultPath: outputPath || defaultName,
      filters: [{ name: "MP4 video", extensions: ["mp4"] }],
    });
    if (picked) setOutputPath(picked);
  };

  const onOpenFolder = async () => {
    if (!active?.outputPath) return;
    // Open the containing folder via shell `open` on the parent dir.
    const parent = active.outputPath.replace(/[\\/][^\\/]+$/, "");
    try {
      await shellOpen(parent);
    } catch (err) {
      console.warn("Failed to open export folder:", err);
    }
  };

  const sizeEstimate = useMemo(() => estimateSizeMb(active?.totalDurationSec ?? 0, resolved.width, resolved.height, resolved.fps, codec, cq), [active?.totalDurationSec, resolved, codec, cq]);

  return (
    <Modal open={open} onClose={onClose} title="Export project" width="640px">
      <div className="p-5 space-y-5 text-sm">
        {clipCount === 0 && (
          <div className="rounded border border-amber-200 bg-amber-50 text-amber-800 px-3 py-2 text-xs flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>Your timeline is empty. Drop a clip onto a track before exporting.</span>
          </div>
        )}

        <FfmpegBanner
          check={ffmpegStatus}
          customPathSet={!!ffmpegPath}
          onRecheck={recheckFfmpeg}
          onLocate={locateFfmpeg}
          onClearPath={() => setFfmpegPath(null)}
        />

        <Section title="Quality">
          <div className="grid grid-cols-2 gap-2">
            <PresetCard
              checked={presetId === "aspect-default"}
              onSelect={() => setPresetId("aspect-default")}
              title={`${aspect} default`}
              detail={`${aspectDefault.width}×${aspectDefault.height} · ${aspectDefault.fps} fps`}
              recommended
            />
            {EXPORT_PRESETS.map((p) => (
              <PresetCard
                key={p.id}
                checked={presetId === p.id}
                onSelect={() => setPresetId(p.id as PresetId)}
                title={p.label}
                detail={`${p.width}×${p.height}`}
              />
            ))}
            <PresetCard
              checked={isCustom}
              onSelect={() => setPresetId("custom")}
              title="Custom"
              detail="Pick your own"
            />
          </div>
        </Section>

        {isCustom && (
          <Section title="Custom settings">
            <div className="grid grid-cols-3 gap-3">
              <Field label="Width">
                <input
                  type="number"
                  value={customWidth}
                  onChange={(e) => setCustomWidth(parseInt(e.target.value, 10) || 0)}
                  className="we-input"
                  min={64}
                  max={7680}
                />
              </Field>
              <Field label="Height">
                <input
                  type="number"
                  value={customHeight}
                  onChange={(e) => setCustomHeight(parseInt(e.target.value, 10) || 0)}
                  className="we-input"
                  min={64}
                  max={4320}
                />
              </Field>
              <Field label="FPS">
                <input
                  type="number"
                  value={customFps}
                  onChange={(e) => setCustomFps(parseInt(e.target.value, 10) || 0)}
                  className="we-input"
                  min={1}
                  max={240}
                />
              </Field>
              <Field label="Video quality (CQ)">
                <input
                  type="number"
                  value={cq}
                  onChange={(e) => setCq(parseInt(e.target.value, 10) || 0)}
                  className="we-input"
                  min={0}
                  max={51}
                />
              </Field>
              <Field label="Audio bitrate (kbps)">
                <input
                  type="number"
                  value={audioBitrate}
                  onChange={(e) => setAudioBitrate(parseInt(e.target.value, 10) || 0)}
                  className="we-input"
                  min={32}
                  max={512}
                />
              </Field>
            </div>
          </Section>
        )}

        <Section title="Encoder">
          <div className="flex gap-2">
            <CodecCard
              icon={Zap}
              title="H.264 NVENC"
              subtitle={
                nvencAvailable === false
                  ? "GPU · not available on this system"
                  : "GPU · fast (recommended)"
              }
              checked={codec === "h264_nvenc"}
              disabled={nvencAvailable === false}
              onSelect={() => {
                codecTouchedRef.current = true;
                setCodec("h264_nvenc");
              }}
            />
            <CodecCard
              icon={Cpu}
              title="H.264 libx264"
              subtitle="CPU · highest quality at low bitrates"
              checked={codec === "libx264"}
              onSelect={() => {
                codecTouchedRef.current = true;
                setCodec("libx264");
              }}
            />
          </div>
          {nvencAvailable === false && (
            <div className="text-[11px] text-we-muted mt-1.5">
              NVENC couldn't encode a test frame on this machine (no supported NVIDIA GPU/driver
              found), so exports use the CPU encoder instead.
            </div>
          )}
        </Section>

        <Section title="Output">
          <div className="flex gap-2">
            <input
              type="text"
              value={resolvingPath ? "Resolving…" : outputPath}
              onChange={(e) => setOutputPath(e.target.value)}
              disabled={resolvingPath || active?.status === "running"}
              className="we-input flex-1 font-mono text-xs"
              title={outputPath}
            />
            <button onClick={() => void onBrowse()} className="we-btn" disabled={active?.status === "running"}>
              <FolderOpen className="w-4 h-4" />
              Browse
            </button>
          </div>
          {sizeEstimate && (
            <div className="text-[11px] text-we-muted mt-1.5">
              Estimated size: ~{sizeEstimate}
            </div>
          )}
        </Section>

        {active && active.status !== "idle" && (
          <ExportStatusBar
            job={active}
            onCancel={cancelExport}
            onOpenFolder={onOpenFolder}
            onDismiss={dismissExport}
          />
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-we-border">
          <button onClick={onClose} className="we-btn">Close</button>
          {(!active || active.status === "complete" || active.status === "error" || active.status === "cancelled") && (
            <button onClick={() => void onStart()} disabled={!canExport} className="we-btn-primary disabled:opacity-50">
              <Play className="w-4 h-4" />
              {active?.status === "complete" ? "Export again" : "Start export"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function FfmpegBanner({
  check,
  customPathSet,
  onRecheck,
  onLocate,
  onClearPath,
}: {
  check: FfmpegCheck | null;
  customPathSet: boolean;
  onRecheck: () => void | Promise<void>;
  onLocate: () => void | Promise<void>;
  onClearPath: () => void | Promise<void>;
}) {
  if (!check) return null;
  if (check.found) {
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] text-emerald-700 flex items-center gap-2">
        <Check className="w-3.5 h-3.5" />
        <span className="flex-1 truncate" title={check.version}>
          ffmpeg ready · {check.version}
        </span>
        {customPathSet && (
          <button onClick={() => void onClearPath()} className="we-btn-ghost px-1.5 py-0.5 text-[11px]">
            Clear custom path
          </button>
        )}
        <button onClick={() => void onRecheck()} className="we-btn-ghost px-1.5 py-0.5" title="Recheck">
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>
    );
  }
  return (
    <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 leading-5">
        <strong>ffmpeg isn't accessible.</strong>{" "}
        {check.error || "Install it via `winget install ffmpeg` and restart WeEdit, or point WeEdit at ffmpeg.exe directly."}
      </div>
      <button onClick={() => void onRecheck()} className="we-btn text-[11px]" title="Re-check">
        <RefreshCw className="w-3 h-3" /> Recheck
      </button>
      <button onClick={() => void onLocate()} className="we-btn text-[11px]" title="Pick ffmpeg.exe">
        <FolderOpen className="w-3 h-3" /> Locate…
      </button>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <div className="text-xs font-medium uppercase tracking-wide text-we-muted">{title}</div>
      {children}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] text-we-muted">{label}</span>
      {children}
    </label>
  );
}

function PresetCard({
  checked,
  onSelect,
  title,
  detail,
  recommended,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  detail: string;
  recommended?: boolean;
}) {
  return (
    <button
      onClick={onSelect}
      className={[
        "text-left rounded-md border px-3 py-2 transition-colors",
        checked ? "border-we-teal bg-we-teal/10" : "border-we-border bg-we-panel hover:bg-we-hover",
      ].join(" ")}
    >
      <div className="text-sm font-medium text-we-ink flex items-center gap-2">
        {title}
        {recommended && (
          <span className="text-[10px] uppercase tracking-wide text-we-teal">recommended</span>
        )}
      </div>
      <div className="text-[11px] text-we-muted">{detail}</div>
    </button>
  );
}

function CodecCard({
  icon: Icon,
  title,
  subtitle,
  checked,
  disabled,
  onSelect,
}: {
  icon: typeof Zap;
  title: string;
  subtitle: string;
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      onClick={onSelect}
      disabled={disabled}
      title={disabled ? "Not available on this system" : undefined}
      className={[
        "flex-1 text-left rounded-md border px-3 py-2.5 transition-colors flex items-start gap-2",
        disabled
          ? "opacity-50 cursor-not-allowed border-we-border bg-we-panel"
          : checked
          ? "border-we-teal bg-we-teal/10"
          : "border-we-border bg-we-panel hover:bg-we-hover",
      ].join(" ")}
    >
      <Icon className={["w-4 h-4 mt-0.5", checked && !disabled ? "text-we-teal" : "text-we-muted"].join(" ")} />
      <div className="min-w-0">
        <div className="text-sm font-medium text-we-ink">{title}</div>
        <div className="text-[11px] text-we-muted">{subtitle}</div>
      </div>
    </button>
  );
}

function ExportStatusBar({
  job,
  onCancel,
  onOpenFolder,
  onDismiss,
}: {
  job: NonNullable<ReturnType<typeof useExports.getState>["active"]>;
  onCancel: () => void | Promise<void>;
  onOpenFolder: () => void | Promise<void>;
  onDismiss: () => void;
}) {
  if (job.status === "error") {
    return (
      <div className="rounded border border-red-200 bg-red-50 px-3 py-2 space-y-1">
        <div className="flex items-start gap-2 text-xs text-red-700">
          <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">Export failed</div>
            <div className="opacity-80">{job.error}</div>
          </div>
          <button onClick={onDismiss} className="we-btn-ghost text-xs">Dismiss</button>
        </div>
        {job.log.length > 0 && (
          <details className="text-[11px] text-red-700 mt-1">
            <summary className="cursor-pointer">ffmpeg log (last {job.log.length} lines)</summary>
            <pre className="mt-1 max-h-32 overflow-auto bg-we-panel/60 p-2 rounded font-mono text-[10px] whitespace-pre-wrap">
              {job.log.join("\n")}
            </pre>
          </details>
        )}
      </div>
    );
  }

  if (job.status === "complete") {
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50 px-3 py-2 flex items-center gap-2 text-xs text-emerald-800">
        <Check className="w-4 h-4" />
        <span className="flex-1 truncate" title={job.outputPath}>Exported to {job.outputPath}</span>
        <button onClick={() => void onOpenFolder()} className="we-btn text-xs">
          <FolderOpen className="w-3.5 h-3.5" /> Show
        </button>
        <button onClick={onDismiss} className="we-btn text-xs">Dismiss</button>
      </div>
    );
  }

  if (job.status === "cancelled") {
    return (
      <div className="rounded border border-we-border bg-we-rail px-3 py-2 flex items-center gap-2 text-xs text-we-muted">
        <CircleSlash className="w-4 h-4" />
        <span className="flex-1">Cancelled.</span>
        <button onClick={onDismiss} className="we-btn text-xs">Dismiss</button>
      </div>
    );
  }

  const pct = Math.round((job.percent ?? 0) * 100);
  const speed = job.speed ? ` · ${job.speed}` : "";
  const fps = job.fps ? ` · ${job.fps} fps` : "";
  const eta = job.etaSec != null && job.etaSec > 0 ? ` · ETA ${formatEta(job.etaSec)}` : "";

  return (
    <div className="rounded border border-we-border bg-we-rail px-3 py-2 space-y-2">
      <div className="flex items-center gap-2 text-xs text-we-ink">
        {job.status === "compiling" ? (
          <Loader2 className="w-4 h-4 animate-spin text-we-teal" />
        ) : (
          <Loader2 className="w-4 h-4 animate-spin text-we-teal" />
        )}
        <span className="flex-1">
          {job.status === "compiling" ? "Compiling export plan…" : `Rendering · ${pct}%${speed}${fps}${eta}`}
        </span>
        <button onClick={() => void onCancel()} className="we-btn text-xs">Cancel</button>
      </div>
      <div className="h-1.5 bg-we-hover rounded overflow-hidden">
        <div className="h-full bg-we-teal transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function formatEta(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${Math.round(sec)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s}s`;
}

function estimateSizeMb(
  durationSec: number,
  width: number,
  height: number,
  fps: number,
  codec: VideoCodec,
  cq: number,
): string | null {
  if (durationSec < 0.1) return null;
  // Very rough heuristic: bits-per-pixel × pixels × fps, then nudged by CQ.
  // Real sizes vary wildly with motion content, but this gives ballpark order.
  const px = width * height;
  const bpp = codec === "h264_nvenc" ? 0.085 : 0.07;
  const cqAdj = Math.pow(1.07, 21 - cq); // each CQ step ~7% size
  const bitsPerSec = px * fps * bpp * cqAdj;
  const audioBitsPerSec = 192 * 1000;
  const bytes = ((bitsPerSec + audioBitsPerSec) / 8) * durationSec;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

// Suppress an "invoke unused" lint if/when we trim imports later.
void invoke;

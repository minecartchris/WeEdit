import { Cpu, Zap } from "lucide-react";
import { useEffect, useState } from "react";
import { detectGpu, type GpuInfo } from "@/lib/gpu";

// Tiny badge in the top bar that confirms GPU acceleration is live.
// Reassurance for the user; also useful when debugging perf issues later.
export function GpuBadge() {
  const [gpu, setGpu] = useState<GpuInfo | null>(null);

  useEffect(() => {
    detectGpu().then(setGpu);
  }, []);

  if (!gpu) return null;

  const accelerated = gpu.backend !== "cpu";
  const Icon = accelerated ? Zap : Cpu;
  const label = gpu.backend === "webgpu" ? "WebGPU" : gpu.backend === "webgl2" ? "WebGL2" : "CPU";
  const tip = gpu.adapter
    ? `${label} · ${gpu.adapter}${gpu.videoDecodeAccelerated ? " · HW video decode" : ""}`
    : label;

  return (
    <span
      title={tip}
      className={[
        "inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium border",
        accelerated
          ? "border-we-teal/30 bg-we-teal/10 text-we-teal"
          : "border-amber-300 bg-amber-50 text-amber-700",
      ].join(" ")}
    >
      <Icon className="w-3 h-3" />
      {label}
    </span>
  );
}

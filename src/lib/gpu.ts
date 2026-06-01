// GPU capability detection. The Preview compositor (Phase 1) prefers WebGPU
// because on Windows it routes straight through DX12 to the dedicated GPU,
// which on this user's 5060 Ti gives full hardware-accelerated compositing.
// We keep WebGL2 as a fallback for older WebView2 builds.

export type GpuBackend = "webgpu" | "webgl2" | "cpu";

export interface GpuInfo {
  backend: GpuBackend;
  /** Adapter / renderer string when available (e.g. "NVIDIA GeForce RTX 5060 Ti"). */
  adapter?: string;
  /** True if hardware-accelerated video decoding is reachable. */
  videoDecodeAccelerated: boolean;
}

export async function detectGpu(): Promise<GpuInfo> {
  // Prefer WebGPU.
  const nav = navigator as Navigator & { gpu?: GPU };
  if (nav.gpu) {
    try {
      const adapter = await nav.gpu.requestAdapter({ powerPreference: "high-performance" });
      if (adapter) {
        // adapter.info is shipping in Chromium ≥ 121 (so WebView2 in Win11 has it).
        type AdapterWithInfo = GPUAdapter & { info?: { device?: string; description?: string } };
        const info = (adapter as AdapterWithInfo).info;
        return {
          backend: "webgpu",
          adapter: info?.description ?? info?.device,
          videoDecodeAccelerated: hasVideoDecoder(),
        };
      }
    } catch {
      /* fall through to WebGL2 */
    }
  }

  // WebGL2 fallback — read renderer name via WEBGL_debug_renderer_info.
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2");
  if (gl) {
    const dbg = gl.getExtension("WEBGL_debug_renderer_info");
    const adapter = dbg ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string) : undefined;
    return {
      backend: "webgl2",
      adapter,
      videoDecodeAccelerated: hasVideoDecoder(),
    };
  }

  return { backend: "cpu", videoDecodeAccelerated: false };
}

function hasVideoDecoder(): boolean {
  return typeof (globalThis as { VideoDecoder?: unknown }).VideoDecoder === "function";
}

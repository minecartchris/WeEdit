import { Check, Download, Film, Loader2, X } from "lucide-react";
import { useMemo, useState } from "react";
import { EXPORT_PRESETS, defaultPresetForAspect } from "@/lib/exportFfmpeg";
import { isTauri } from "@/lib/platform";
import { useCollab } from "@/state/collab";
import { useEditor } from "@/state/editor";
import { useRemoteExports } from "@/state/remoteExports";

// "Export on the host": the browser editor's Export dialog, and the prompt the
// desktop host gets when someone asks.

/** Export dialog body in the browser editor. */
export function RemoteExportPanel() {
  const status = useCollab((s) => s.status);
  const peers = useCollab((s) => s.peers);
  const aspect = useEditor((s) => s.project.aspectRatio);
  const requests = useRemoteExports((s) => s.requests);
  const mine = useRemoteExports((s) => s.mine);
  const request = useRemoteExports((s) => s.request);
  const dismissMine = useRemoteExports((s) => s.dismissMine);
  const presets = useMemo(() => [defaultPresetForAspect(aspect), ...EXPORT_PRESETS], [aspect]);
  const [presetId, setPresetId] = useState(presets[0].id);
  const host = Object.values(peers).find((p) => p.role === "host");
  const mineReq = mine ? requests.find((r) => r.id === mine.id) : undefined;

  if (status !== "connected") {
    return (
      <div className="p-5 text-sm text-we-ink flex flex-col gap-3">
        <p>
          Exporting needs the desktop app — the browser can't run the video encoder. Two ways to get your video:
        </p>
        <ul className="list-disc pl-5 text-we-muted text-xs leading-6">
          <li>Download WeEdit for Windows or Linux and export there.</li>
          <li>
            Edit in a collaboration session with someone on the desktop app, and ask them to export it for you — it
            arrives here as a normal download.
          </li>
        </ul>
      </div>
    );
  }

  const preset = presets.find((p) => p.id === presetId) ?? presets[0];
  const busy = mine && (mine.phase === "waiting" || mine.phase === "downloading");

  return (
    <div className="p-5 text-sm flex flex-col gap-4">
      <p className="text-xs text-we-muted leading-5">
        The browser can't encode video, so the session host renders it on their computer and sends you the file.
        {host ? ` Your host is ${host.name}.` : " There's no desktop host in this session right now."}
      </p>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-we-muted">Format</span>
        <select value={presetId} onChange={(e) => setPresetId(e.target.value)} className="we-input" disabled={!!busy}>
          {presets.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label} ({p.width}×{p.height})
            </option>
          ))}
        </select>
      </label>

      {mine && (
        <div className="rounded-lg border border-we-border p-3 text-sm flex items-center gap-2">
          {mine.phase === "saved" ? (
            <Check className="w-4 h-4 text-we-teal" />
          ) : mine.phase === "failed" ? (
            <X className="w-4 h-4 text-red-500" />
          ) : (
            <Loader2 className="w-4 h-4 animate-spin text-we-teal" />
          )}
          <span className="flex-1">
            {mine.phase === "waiting" &&
              (mineReq?.status === "exporting"
                ? `The host is exporting… ${Math.round((mineReq.progress ?? 0) * 100)}%`
                : "Waiting for the host to accept…")}
            {mine.phase === "downloading" && "Receiving the video from the host…"}
            {mine.phase === "saved" && "Done — the video was saved to your downloads."}
            {mine.phase === "failed" && `Didn't work: ${mine.error ?? "unknown error"}`}
          </span>
          {!busy && (
            <button onClick={dismissMine} className="we-btn-ghost p-1" aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="flex justify-end">
        <button
          onClick={() =>
            request({
              width: preset.width,
              height: preset.height,
              fps: preset.fps,
              cq: preset.cq,
              audioBitrateKbps: preset.audioBitrateKbps,
              reframe: "fill",
              reframeFocus: 0.5,
              label: preset.label,
            })
          }
          disabled={!host || !!busy}
          className="we-btn-primary disabled:opacity-50"
        >
          <Film className="w-4 h-4" /> Ask the host to export
        </button>
      </div>
    </div>
  );
}

/** Desktop host: a prompt per pending request, plus progress while exporting. */
export function RemoteExportPrompts() {
  const myRole = useCollab((s) => s.myRole);
  const requests = useRemoteExports((s) => s.requests);
  const accept = useRemoteExports((s) => s.accept);
  const decline = useRemoteExports((s) => s.decline);
  if (!isTauri() || myRole !== "host") return null;
  const open = requests.filter((r) => r.status === "requested" || r.status === "exporting");
  if (open.length === 0) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 w-[420px]">
      {open.map((r) => (
        <div key={r.id} className="rounded-xl border border-we-border bg-we-panel shadow-2xl p-3 flex flex-col gap-2">
          <div className="flex items-center gap-2 text-sm text-we-ink">
            <Download className="w-4 h-4 text-we-teal" />
            {r.status === "requested" ? (
              <span>
                <strong>{r.fromName}</strong> asks you to export the project ({r.opts.label}) and send it to them.
              </span>
            ) : (
              <span>
                Exporting for <strong>{r.fromName}</strong>… {Math.round((r.progress ?? 0) * 100)}%
              </span>
            )}
          </div>
          {r.status === "requested" && (
            <div className="flex justify-end gap-2">
              <button onClick={() => decline(r.id)} className="we-btn text-xs py-1">
                Decline
              </button>
              <button onClick={() => accept(r.id)} className="we-btn-primary text-xs py-1">
                Export & send
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

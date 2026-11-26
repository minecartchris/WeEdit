import { downloadDir } from "@tauri-apps/api/path";
import * as Y from "yjs";
import { fetchFile, isHeldByPeer, shareFile } from "@/lib/collab/mediaSync";
import { checkNvenc } from "@/lib/ffmpeg";
import { isTauri } from "@/lib/platform";
import { useEditor } from "@/state/editor";
import { useExports } from "@/state/exports";
import { useRemoteExports, type RemoteExportOptions, type RemoteExportRequest } from "@/state/remoteExports";

// "Export on the host": a collaborator who can't export (the browser editor
// has no ffmpeg) asks the session's desktop host to do it. The request goes in
// the shared doc (map "exports"); the host's WeEdit asks the host, renders the
// project with the requested preset into its Downloads folder, then shares the
// file over the session's peer-to-peer file transfer. The requester's WeEdit
// downloads it and hands it to the browser as a normal file download.

/** How long the requester waits for the host to start advertising the file. */
const HOLDER_WAIT_MS = 60_000;

export function bindRemoteExport(
  doc: Y.Doc,
  selfPid: string,
  identity: () => { name: string },
  isHost: () => boolean,
): () => void {
  const map = doc.getMap<RemoteExportRequest>("exports");
  const fetching = new Set<string>();

  const update = (id: string, patch: Partial<RemoteExportRequest>) => {
    const cur = map.get(id);
    if (cur) map.set(id, { ...cur, ...patch });
  };

  // Requester: once the host has the file ready, pull it and save it.
  const collectMine = async (req: RemoteExportRequest) => {
    if (fetching.has(req.id) || !req.hash || !req.fileName) return;
    fetching.add(req.id);
    useRemoteExports.setState({ mine: { id: req.id, phase: "downloading" } });
    try {
      const deadline = Date.now() + HOLDER_WAIT_MS;
      while (!isHeldByPeer(req.hash) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
      }
      const src = await fetchFile(req.hash, req.fileName, req.size ?? 0);
      saveToDevice(src, req.fileName);
      useRemoteExports.setState({ mine: { id: req.id, phase: "saved" } });
    } catch (err) {
      useRemoteExports.setState({
        mine: { id: req.id, phase: "failed", error: err instanceof Error ? err.message : String(err) },
      });
    }
  };

  const sync = () => {
    const requests = [...map.values()].sort((a, b) => a.at - b.at);
    useRemoteExports.setState({ requests });
    for (const r of requests) {
      if (r.fromPid !== selfPid) continue;
      if (r.status === "done") void collectMine(r);
      if (r.status === "declined" || r.status === "failed") {
        const mine = useRemoteExports.getState().mine;
        if (mine?.id === r.id && mine.phase === "waiting") {
          useRemoteExports.setState({
            mine: { id: r.id, phase: "failed", error: r.status === "declined" ? "The host declined." : r.error },
          });
        }
      }
    }
  };
  map.observe(sync);
  sync();

  useRemoteExports.setState({
    request: (opts: RemoteExportOptions) => {
      const id = crypto.randomUUID();
      map.set(id, {
        id,
        fromPid: selfPid,
        fromName: identity().name,
        opts,
        status: "requested",
        at: Date.now(),
      });
      useRemoteExports.setState({ mine: { id, phase: "waiting" } });
    },
    decline: (id: string) => {
      if (isHost()) update(id, { status: "declined" });
    },
    accept: (id: string) => {
      const req = map.get(id);
      if (!req || !isHost() || !isTauri() || req.status !== "requested") return;
      void runHostExport(req);
    },
  });

  // Host: render the export, then share the file.
  async function runHostExport(req: RemoteExportRequest) {
    update(req.id, { status: "exporting", progress: 0 });
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const dir = `${(await downloadDir()).replace(/\\/g, "/").replace(/\/$/, "")}/WeEdit exports`;
      await invoke("ensure_dir", { path: dir });
      const project = useEditor.getState().project.name.replace(/[\\/:*?"<>|]/g, "_");
      const fileName = `${project} for ${req.fromName.replace(/[\\/:*?"<>|]/g, "_")} ${new Date()
        .toISOString()
        .slice(0, 16)
        .replace(/[:T]/g, "-")}.mp4`;
      const outputPath = `${dir}/${fileName}`;

      const unsub = useExports.subscribe((s) => {
        const p = s.active?.percent;
        if (p != null && s.active?.status === "running") update(req.id, { progress: p });
      });
      try {
        await useExports.getState().start({
          ...req.opts,
          videoCodec: (await checkNvenc()) ? "h264_nvenc" : "libx264",
          outputPath,
        });
      } finally {
        unsub();
      }
      const result = useExports.getState().active;
      if (result?.status !== "complete") throw new Error(result?.error ?? "The export didn't finish.");

      const { hash, size } = await shareFile(outputPath, fileName);
      update(req.id, { status: "done", progress: 1, hash, size, fileName });
    } catch (err) {
      update(req.id, { status: "failed", error: err instanceof Error ? err.message : String(err) });
    }
  }

  return () => {
    map.unobserve(sync);
    useRemoteExports.setState({
      requests: [],
      request: () => {},
      accept: () => {},
      decline: () => {},
    });
  };
}

/** Hand a finished file to the user: a browser download, or open its folder on desktop. */
function saveToDevice(src: string, fileName: string): void {
  if (isTauri()) return; // desktop requesters already have it on disk via the fetch
  const a = document.createElement("a");
  a.href = src;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

import {
  ArrowLeft,
  ChevronRight,
  FileVideo,
  Folder,
  HardDrive,
  Image as ImageIcon,
  Music,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { startNasFileDrag } from "@/lib/customDrag";
import { authenticate, listShare, uncRoot, type DirEntry } from "@/lib/nas";
import { classifyByExt, importPath } from "@/lib/media";
import { useEditor } from "@/state/editor";
import { useIntegrations } from "@/state/integrations";
import type { NasConnection } from "@/lib/config";

// Inline panel rendered when the user selects the "NAS" sidebar tab.
// Top-level shows saved connections + Add button; clicking one drills into
// the share browser with breadcrumbs.
export function NasPanel() {
  const loaded = useIntegrations((s) => s.loaded);
  const connections = useIntegrations((s) => s.nas);
  const [activeConn, setActiveConn] = useState<NasConnection | null>(null);
  const [addingNew, setAddingNew] = useState(false);

  if (!loaded) {
    return <div className="flex-1 grid place-items-center text-sm text-we-muted">Loading…</div>;
  }

  if (activeConn) {
    return (
      <BrowseShare
        conn={activeConn}
        onBack={() => setActiveConn(null)}
      />
    );
  }
  if (addingNew) {
    return (
      <ConnectionForm
        onCancel={() => setAddingNew(false)}
        onSaved={(conn) => {
          setAddingNew(false);
          setActiveConn(conn);
        }}
      />
    );
  }
  return (
    <ConnectionList
      connections={connections}
      onPick={setActiveConn}
      onAdd={() => setAddingNew(true)}
    />
  );
}

// ── Connection list ──

function ConnectionList({
  connections,
  onPick,
  onAdd,
}: {
  connections: NasConnection[];
  onPick: (conn: NasConnection) => void;
  onAdd: () => void;
}) {
  const removeNas = useIntegrations((s) => s.removeNas);
  return (
    <div className="p-5 max-w-3xl mx-auto space-y-3">
      <div className="flex items-center gap-2 text-we-ink">
        <HardDrive className="w-5 h-5 text-we-teal" />
        <h2 className="text-base font-medium">Network locations</h2>
      </div>

      {connections.length === 0 ? (
        <div className="rounded-lg border border-dashed border-we-border p-8 text-center text-we-muted text-sm">
          <HardDrive className="w-8 h-8 mx-auto mb-2 opacity-60" />
          No NAS connections yet.
        </div>
      ) : (
        <ul className="divide-y divide-we-border border border-we-border rounded-lg overflow-hidden">
          {connections.map((c) => (
            <li
              key={c.id}
              className="flex items-center gap-3 px-4 py-3 hover:bg-slate-50 cursor-pointer"
              onClick={() => onPick(c)}
            >
              <HardDrive className="w-5 h-5 text-we-muted" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-we-ink truncate">{c.name}</div>
                <div className="text-[11px] text-we-muted truncate">
                  \\{c.host}\{c.share}
                  {c.username ? ` · ${c.username}` : ""}
                </div>
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Remove "${c.name}"?`)) void removeNas(c.id);
                }}
                className="we-btn-ghost p-1.5"
                title="Remove"
                aria-label="Remove connection"
              >
                <Trash2 className="w-4 h-4" />
              </button>
              <ChevronRight className="w-4 h-4 text-we-muted" />
            </li>
          ))}
        </ul>
      )}

      <div className="flex justify-end">
        <button onClick={onAdd} className="we-btn-primary">
          <Plus className="w-4 h-4" />
          Add connection
        </button>
      </div>
    </div>
  );
}

// ── New connection form ──

function ConnectionForm({
  onSaved,
  onCancel,
}: {
  onSaved: (conn: NasConnection) => void;
  onCancel: () => void;
}) {
  const upsertNas = useIntegrations((s) => s.upsertNas);
  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [share, setShare] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canSave = host.trim() && share.trim();

  const onConnect = async () => {
    setError(null);
    setBusy(true);
    const conn: NasConnection = {
      id: crypto.randomUUID(),
      name: name.trim() || `${host.trim()}\\${share.trim()}`,
      host: host.trim(),
      share: share.trim(),
      username: username.trim() || undefined,
      password: password || undefined,
    };
    try {
      if (conn.username || conn.password) {
        await authenticate(conn);
      }
      await listShare(conn);
      await upsertNas(conn);
      onSaved(conn);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-5 max-w-3xl mx-auto space-y-4 text-sm">
      <div className="flex items-center gap-2 text-we-ink">
        <HardDrive className="w-5 h-5 text-we-teal" />
        <h2 className="text-base font-medium">New NAS connection</h2>
      </div>

      <p className="text-we-muted">
        Enter your NAS's host and share name. If the share is anonymous or your Windows
        user already has access, leave the credentials blank.
      </p>

      <div className="grid grid-cols-2 gap-3">
        <Field label="Name (display only)">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Studio NAS" className="we-input" />
        </Field>
        <Field label="Host / IP">
          <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.10  or  nas.local" className="we-input" />
        </Field>
        <Field label="Share name">
          <input value={share} onChange={(e) => setShare(e.target.value)} placeholder="vods" className="we-input" />
        </Field>
        <div /> {/* spacer */}
        <Field label="Username (optional)">
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="risto" className="we-input" autoComplete="username" />
        </Field>
        <Field label="Password (optional)">
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="••••••••" className="we-input" autoComplete="current-password" />
        </Field>
      </div>

      {error && (
        <div className="rounded-md bg-red-50 border border-red-100 text-red-700 p-3 text-xs">{error}</div>
      )}

      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="we-btn" disabled={busy}>Cancel</button>
        <button
          onClick={() => void onConnect()}
          disabled={!canSave || busy}
          className="we-btn-primary disabled:opacity-50"
        >
          {busy ? "Connecting…" : "Connect & save"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-medium text-we-ink">{label}</span>
      {children}
    </label>
  );
}

// ── Browse share ──

function BrowseShare({ conn, onBack }: { conn: NasConnection; onBack: () => void }) {
  const [subpath, setSubpath] = useState<string>("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState<Set<string>>(new Set());
  const addMedia = useEditor((s) => s.addMedia);

  const refresh = useCallback(
    async (path = subpath) => {
      setLoading(true);
      setError(null);
      try {
        const list = await listShare(conn, path);
        setEntries(list);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [conn, subpath],
  );

  useEffect(() => {
    void refresh(subpath);
  }, [subpath, refresh]);

  const breadcrumbs = useMemo(() => {
    const parts = subpath.split("/").filter(Boolean);
    return parts.map((part, idx) => ({
      label: part,
      target: parts.slice(0, idx + 1).join("/"),
    }));
  }, [subpath]);

  const goInto = (entry: DirEntry) => {
    if (!entry.isDirectory) return;
    setSubpath((p) => (p ? `${p}/${entry.name}` : entry.name));
  };

  const goUp = () => {
    if (!subpath) return;
    const parts = subpath.split("/").filter(Boolean);
    parts.pop();
    setSubpath(parts.join("/"));
  };

  const importFile = async (entry: DirEntry) => {
    if (entry.isDirectory) return;
    setImporting((s) => new Set(s).add(entry.path));
    try {
      const item = await importPath(entry.path);
      if (item) addMedia(item);
    } catch (err) {
      console.error("Import failed", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting((s) => {
        const next = new Set(s);
        next.delete(entry.path);
        return next;
      });
    }
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2 px-5 py-2 border-b border-we-border bg-white">
        <button onClick={onBack} className="we-btn-ghost p-1" title="Back to connections">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <HardDrive className="w-4 h-4 text-we-muted" />
        <button
          onClick={() => setSubpath("")}
          className="text-sm font-medium text-we-ink hover:underline"
        >
          {uncRoot(conn)}
        </button>
        {breadcrumbs.map((b) => (
          <span key={b.target} className="flex items-center gap-1 text-sm text-we-muted">
            <span>/</span>
            <button onClick={() => setSubpath(b.target)} className="hover:underline text-we-ink">
              {b.label}
            </button>
          </span>
        ))}
        <div className="flex-1" />
        <button onClick={() => void refresh()} className="we-btn" title="Refresh">
          <RefreshCw className={["w-4 h-4", loading ? "animate-spin" : ""].join(" ")} />
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">{error}</div>
      )}

      <div className="flex-1 overflow-auto">
        {subpath && (
          <button
            onClick={goUp}
            className="w-full flex items-center gap-3 px-5 py-2 hover:bg-slate-50 text-sm text-we-muted border-b border-we-border"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Up one folder</span>
          </button>
        )}
        {loading && entries.length === 0 ? (
          <div className="text-center text-sm text-we-muted py-8">Loading…</div>
        ) : entries.length === 0 ? (
          <div className="text-center text-sm text-we-muted py-8">Empty.</div>
        ) : (
          <ul className="divide-y divide-we-border">
            {entries.map((e) => {
              const kind = e.isDirectory ? null : classifyByExt(e.name);
              const supported = e.isDirectory || kind != null;
              const Icon = e.isDirectory
                ? Folder
                : kind === "video"
                ? FileVideo
                : kind === "image"
                ? ImageIcon
                : kind === "audio"
                ? Music
                : FileVideo;
              return (
                <li
                  key={e.path}
                  className={[
                    "flex items-center gap-3 px-5 py-2 text-sm select-none",
                    supported ? "hover:bg-slate-50" : "opacity-50",
                    e.isDirectory ? "cursor-pointer" : kind ? "cursor-grab active:cursor-grabbing" : "",
                  ].join(" ")}
                  title={
                    e.isDirectory
                      ? "Open folder"
                      : kind
                      ? "Drag onto a track, or click Import to add to the library"
                      : "Unsupported file"
                  }
                  onMouseDown={(ev) => {
                    if (!e.isDirectory && supported) startNasFileDrag(ev, e.path);
                  }}
                  onClick={() => {
                    if (e.isDirectory) goInto(e);
                  }}
                >
                  <Icon className={["w-4 h-4", e.isDirectory ? "text-we-teal" : "text-we-muted"].join(" ")} />
                  <span className="flex-1 min-w-0 truncate">{e.name}</span>
                  {!e.isDirectory && (
                    <span className="text-[11px] text-we-muted tabular-nums">{humanSize(e.sizeBytes)}</span>
                  )}
                  {!e.isDirectory && supported && (
                    <button
                      onClick={(ev) => {
                        ev.stopPropagation();
                        void importFile(e);
                      }}
                      disabled={importing.has(e.path)}
                      className="we-btn text-xs"
                    >
                      {importing.has(e.path) ? "Importing…" : "Import"}
                    </button>
                  )}
                  <ChevronRight className={["w-4 h-4 text-we-muted", e.isDirectory ? "" : "opacity-0"].join(" ")} />
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

function humanSize(bytes?: number): string {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`;
}

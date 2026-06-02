import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  AlertTriangle,
  Check,
  Copy,
  Download,
  ExternalLink,
  FolderOpen,
  LogOut,
  RefreshCw,
  Tv,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getCurrentUser,
  listUserVideos,
  pollDeviceToken,
  prettyDuration,
  refreshAccessToken,
  requestDeviceCode,
  thumbnailUrl,
  ytDlpCommand,
  type DeviceCodeResponse,
  type TwitchVideo,
} from "@/lib/twitch";
import { checkYtDlp, type YtDlpCheck } from "@/lib/ytdlp";
import { useDownloads, type DownloadEntry } from "@/state/downloads";
import { useIntegrations } from "@/state/integrations";
import type { TwitchConfig } from "@/lib/config";

// Inline panel rendered when the user selects the "Twitch" sidebar tab.
// State machine: setup (paste Client ID) → authorizing (device code) → ready (VOD list).
export function TwitchPanel() {
  const twitch = useIntegrations((s) => s.twitch);
  const setTwitch = useIntegrations((s) => s.setTwitch);
  const loaded = useIntegrations((s) => s.loaded);

  if (!loaded) {
    return <div className="flex-1 grid place-items-center text-sm text-we-muted">Loading…</div>;
  }

  if (!twitch?.clientId) {
    return <SetupForm onSave={(clientId) => setTwitch({ clientId })} />;
  }

  if (!twitch.accessToken) {
    return (
      <DeviceFlow
        clientId={twitch.clientId}
        onAuthed={async (auth, user) => {
          await setTwitch({
            ...twitch,
            accessToken: auth.access_token,
            refreshToken: auth.refresh_token,
            expiresAt: Date.now() + auth.expires_in * 1000,
            userId: user.id,
            login: user.login,
            displayName: user.display_name,
            profileImageUrl: user.profile_image_url,
          });
        }}
        onReset={() => setTwitch(null)}
      />
    );
  }

  return <VodList twitch={twitch} onLogout={() => setTwitch({ clientId: twitch.clientId })} />;
}

// ── Setup ──

function SetupForm({ onSave }: { onSave: (clientId: string) => void | Promise<void> }) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  return (
    <div className="p-6 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-we-ink">
        <Tv className="w-5 h-5 text-we-teal" />
        <h2 className="text-base font-medium">Connect to Twitch</h2>
      </div>

      <div className="text-sm text-we-ink leading-6">
        WeEdit needs a <strong>Twitch Client ID</strong>. It's free and takes about a minute:
        <ol className="list-decimal pl-6 mt-2 space-y-1 text-we-muted">
          <li>
            Go to{" "}
            <button
              onClick={() => void shellOpen("https://dev.twitch.tv/console/apps/create")}
              className="text-we-teal hover:underline"
            >
              dev.twitch.tv → Register Your Application
            </button>
            .
          </li>
          <li>Name it anything (e.g. "WeEdit local"). Category: <em>Application Integration</em>.</li>
          <li>
            For OAuth Redirect URL, enter <code className="bg-we-hover px-1 rounded">http://localhost</code>{" "}
            (it isn't used here, but Twitch requires the field).
          </li>
          <li>Copy the <strong>Client ID</strong> and paste it below.</li>
        </ol>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-we-ink">Client ID</label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="e.g. abcdefghij1234567890klmnop"
          className="we-input"
        />
      </div>

      <div className="flex justify-end">
        <button
          onClick={() => trimmed && void onSave(trimmed)}
          disabled={!trimmed}
          className="we-btn-primary disabled:opacity-50"
        >
          Continue
        </button>
      </div>
    </div>
  );
}

// ── Authorize ──

function DeviceFlow({
  clientId,
  onAuthed,
  onReset,
}: {
  clientId: string;
  onAuthed: (
    auth: Awaited<ReturnType<typeof pollDeviceToken>> & object,
    user: Awaited<ReturnType<typeof getCurrentUser>>,
  ) => void;
  onReset: () => void;
}) {
  const [code, setCode] = useState<DeviceCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollingRef = useRef(false);

  const start = useCallback(async () => {
    setError(null);
    setCode(null);
    try {
      const resp = await requestDeviceCode(clientId);
      setCode(resp);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [clientId]);

  useEffect(() => {
    void start();
  }, [start]);

  useEffect(() => {
    if (!code) return;
    if (pollingRef.current) return;
    pollingRef.current = true;

    const stopAt = Date.now() + code.expires_in * 1000;
    const intervalMs = Math.max(1000, code.interval * 1000);
    let cancelled = false;

    (async () => {
      while (!cancelled && Date.now() < stopAt) {
        try {
          const token = await pollDeviceToken(clientId, code.device_code);
          if (token) {
            const user = await getCurrentUser(clientId, token.access_token);
            if (!cancelled) onAuthed(token, user);
            return;
          }
        } catch (err) {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
          return;
        }
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      if (!cancelled) setError("Authorization timed out. Try again.");
    })();

    return () => {
      cancelled = true;
      pollingRef.current = false;
    };
  }, [code, clientId, onAuthed]);

  if (error) {
    return (
      <div className="p-6 max-w-md mx-auto space-y-3 text-sm">
        <p className="text-red-700">Authorization failed: {error}</p>
        <div className="flex gap-2">
          <button onClick={() => void start()} className="we-btn">Retry</button>
          <button onClick={onReset} className="we-btn">Use a different Client ID</button>
        </div>
      </div>
    );
  }

  if (!code) {
    return <div className="p-8 text-center text-sm text-we-muted">Requesting code from Twitch…</div>;
  }

  return (
    <div className="p-6 max-w-md mx-auto space-y-4 text-sm">
      <p className="text-we-ink leading-6">
        Open the Twitch verification page and enter the code below. WeEdit will detect
        the approval automatically.
      </p>

      <div className="rounded-lg border border-we-border bg-we-rail p-5 space-y-3 text-center">
        <div className="text-xs uppercase tracking-wide text-we-muted">Your code</div>
        <div className="font-mono text-3xl font-semibold tabular-nums text-we-ink select-text">
          {code.user_code}
        </div>
        <div className="flex justify-center gap-2 pt-1">
          <button
            onClick={() => void navigator.clipboard.writeText(code.user_code)}
            className="we-btn"
          >
            <Copy className="w-4 h-4" /> Copy code
          </button>
          <button
            onClick={() => void shellOpen(code.verification_uri)}
            className="we-btn-primary"
          >
            <ExternalLink className="w-4 h-4" /> Open Twitch
          </button>
        </div>
        <div className="text-[11px] text-we-muted pt-1 truncate">
          {code.verification_uri}
        </div>
      </div>

      <div className="text-xs text-we-muted text-center">Waiting for you to approve in the browser…</div>
    </div>
  );
}

// ── VOD list ──

function VodList({ twitch, onLogout }: { twitch: TwitchConfig; onLogout: () => void }) {
  const [videos, setVideos] = useState<TwitchVideo[] | null>(null);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ytdlp, setYtdlp] = useState<YtDlpCheck | null>(null);
  const ytdlpPath = useIntegrations((s) => s.ytdlpPath);
  const setYtdlpPath = useIntegrations((s) => s.setYtdlpPath);
  const setTwitch = useIntegrations((s) => s.setTwitch);

  // Refresh the access token if it's within 60s of expiring (or already
  // expired). Returns a fresh token, or throws if refresh fails — in which
  // case the caller should drop the user back into the device-flow screen.
  const ensureFreshToken = useCallback(async (): Promise<string> => {
    if (!twitch.accessToken) throw new Error("Not authenticated");
    const buffer = 60 * 1000;
    const stillValid =
      twitch.expiresAt == null || Date.now() < twitch.expiresAt - buffer;
    if (stillValid) return twitch.accessToken;
    if (!twitch.refreshToken) throw new Error("Token expired and no refresh token");
    const next = await refreshAccessToken(twitch.clientId, twitch.refreshToken);
    await setTwitch({
      ...twitch,
      accessToken: next.access_token,
      refreshToken: next.refresh_token,
      expiresAt: Date.now() + next.expires_in * 1000,
    });
    return next.access_token;
  }, [twitch, setTwitch]);

  const recheckYtDlp = useCallback(async () => {
    setYtdlp(await checkYtDlp());
  }, []);

  useEffect(() => {
    void recheckYtDlp();
  }, [recheckYtDlp, ytdlpPath]);

  const locateYtDlp = async () => {
    const picked = await openDialog({
      title: "Locate yt-dlp.exe",
      filters: [{ name: "Executable", extensions: ["exe"] }],
      multiple: false,
    });
    if (!picked) return;
    const path = Array.isArray(picked) ? picked[0] : picked;
    if (path) await setYtdlpPath(path);
  };

  const clearYtDlpPath = async () => {
    await setYtdlpPath(null);
  };

  const fetchPage = useCallback(
    async (after?: string) => {
      if (!twitch.userId) return;
      setLoading(true);
      setError(null);
      try {
        const accessToken = await ensureFreshToken();
        const { videos: page, cursor: nextCursor } = await listUserVideos(
          twitch.clientId,
          accessToken,
          twitch.userId,
          after,
        );
        setVideos((prev) => (after ? [...(prev ?? []), ...page] : page));
        setCursor(nextCursor);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // If refresh failed, drop credentials so the panel returns to device-flow.
        if (msg.toLowerCase().includes("refresh") || msg.includes("401")) {
          await setTwitch({ ...twitch, accessToken: undefined, refreshToken: undefined, expiresAt: undefined });
        } else {
          setError(msg);
        }
      } finally {
        setLoading(false);
      }
    },
    [twitch, ensureFreshToken, setTwitch],
  );

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-we-border bg-we-panel">
        {twitch.profileImageUrl && (
          <img src={twitch.profileImageUrl} alt="" className="w-8 h-8 rounded-full" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-we-ink truncate">
            {twitch.displayName ?? twitch.login}
          </div>
          <div className="text-[11px] text-we-muted">Twitch · connected</div>
        </div>
        <button onClick={() => void fetchPage()} className="we-btn" title="Refresh">
          <RefreshCw className={["w-4 h-4", loading ? "animate-spin" : ""].join(" ")} />
          Refresh
        </button>
        <button onClick={onLogout} className="we-btn" title="Disconnect">
          <LogOut className="w-4 h-4" />
          Disconnect
        </button>
      </div>

      {error && (
        <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100">{error}</div>
      )}

      <YtDlpBanner
        check={ytdlp}
        customPathSet={!!ytdlpPath}
        onRecheck={recheckYtDlp}
        onLocate={locateYtDlp}
        onClearPath={clearYtDlpPath}
      />

      <div className="flex-1 overflow-auto p-4">
        {videos === null && loading ? (
          <div className="text-center text-sm text-we-muted py-8">Loading VODs…</div>
        ) : !videos || videos.length === 0 ? (
          <div className="text-center text-sm text-we-muted py-8">
            No archived VODs for this account.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {videos.map((v) => (
              <VodCard key={v.id} video={v} />
            ))}
          </div>
        )}

        {videos && videos.length > 0 && cursor && (
          <div className="text-center pt-4">
            <button
              onClick={() => void fetchPage(cursor)}
              disabled={loading}
              className="we-btn"
            >
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function YtDlpBanner({
  check,
  customPathSet,
  onRecheck,
  onLocate,
  onClearPath,
}: {
  check: YtDlpCheck | null;
  customPathSet: boolean;
  onRecheck: () => void | Promise<void>;
  onLocate: () => void | Promise<void>;
  onClearPath: () => void | Promise<void>;
}) {
  if (!check) return null; // still checking
  if (check.found) {
    return (
      <div className="px-5 py-1.5 text-[11px] text-emerald-700 bg-emerald-50 border-b border-emerald-100 flex items-center gap-2">
        <Check className="w-3.5 h-3.5" />
        <span className="flex-1 truncate" title={check.version}>
          yt-dlp ready · {check.version}
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
    <div className="px-5 py-2 text-xs text-amber-800 bg-amber-50 border-b border-amber-100 flex items-start gap-2">
      <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0" />
      <div className="flex-1 leading-5">
        <strong>yt-dlp isn't accessible.</strong>{" "}
        {check.error || "It may not be on PATH yet — try restarting WeEdit so the new PATH is picked up, or point WeEdit at yt-dlp.exe directly."}
      </div>
      <button onClick={() => void onRecheck()} className="we-btn text-[11px]" title="Re-check">
        <RefreshCw className="w-3 h-3" /> Recheck
      </button>
      <button onClick={() => void onLocate()} className="we-btn text-[11px]" title="Pick yt-dlp.exe">
        <FolderOpen className="w-3 h-3" /> Locate…
      </button>
    </div>
  );
}

function VodCard({ video }: { video: TwitchVideo }) {
  const startDownload = useDownloads((s) => s.start);
  const dismiss = useDownloads((s) => s.dismiss);
  const download = useDownloads((s) => s.byUrl[video.url]);

  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await navigator.clipboard.writeText(ytDlpCommand(video.url));
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const onDownload = () => {
    void startDownload(video.url, video.title || "Twitch VOD");
  };

  return (
    <div className="rounded-lg border border-we-border overflow-hidden bg-we-panel hover:shadow-md transition-shadow flex flex-col">
      <div className="aspect-video bg-slate-900 relative overflow-hidden">
        <img
          src={thumbnailUrl(video.thumbnail_url, 480, 270)}
          alt=""
          draggable={false}
          className="w-full h-full object-cover"
        />
        <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] tabular-nums">
          {prettyDuration(video.duration)}
        </span>
      </div>
      <div className="p-3 space-y-2 flex-1 flex flex-col">
        <div className="text-sm font-medium text-we-ink line-clamp-2" title={video.title}>
          {video.title || "Untitled"}
        </div>
        <div className="text-[11px] text-we-muted">
          {new Date(video.published_at).toLocaleDateString()} ·{" "}
          {video.view_count.toLocaleString()} views
        </div>

        {download ? (
          <DownloadStatus entry={download} onDismiss={() => dismiss(video.url)} />
        ) : (
          <div className="flex flex-wrap gap-2 pt-1 mt-auto">
            <button
              onClick={onDownload}
              className="we-btn-primary text-xs"
              title="Download to project via yt-dlp"
            >
              <Download className="w-3.5 h-3.5" />
              Download
            </button>
            <button onClick={onCopy} className="we-btn text-xs" title="yt-dlp download command">
              <Copy className="w-3.5 h-3.5" />
              {copied ? "Copied!" : "Copy yt-dlp"}
            </button>
            <button
              onClick={() => void shellOpen(video.url)}
              className="we-btn text-xs"
              title="Open on Twitch"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              Open
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function DownloadStatus({ entry, onDismiss }: { entry: DownloadEntry; onDismiss: () => void }) {
  if (entry.status === "error") {
    return (
      <div className="mt-auto rounded border border-red-200 bg-red-50 p-2 text-[11px] text-red-700">
        <div className="flex items-start gap-2">
          <span className="flex-1">{entry.error || "Download failed."}</span>
          <button onClick={onDismiss} className="we-btn-ghost p-0.5"><X className="w-3 h-3" /></button>
        </div>
        {!entry.error?.includes("install") ? null : (
          <div className="pt-1 text-red-600">
            Run <code className="bg-we-panel/60 px-1 rounded">winget install yt-dlp</code> in PowerShell, then retry.
          </div>
        )}
      </div>
    );
  }

  if (entry.status === "complete") {
    return (
      <div className="mt-auto rounded border border-emerald-200 bg-emerald-50 p-2 text-[11px] text-emerald-800 flex items-center gap-2">
        <Check className="w-3.5 h-3.5" />
        <span className="flex-1 truncate" title={entry.filepath}>
          Added to library
        </span>
        <button onClick={onDismiss} className="we-btn-ghost p-0.5"><X className="w-3 h-3" /></button>
      </div>
    );
  }

  // starting | downloading | importing
  const isImporting = entry.status === "importing";
  const label = isImporting
    ? "Importing…"
    : entry.status === "starting"
    ? "Starting…"
    : `${entry.percent.toFixed(1)}% · ${entry.speed ?? ""}${entry.eta ? ` · ETA ${entry.eta}` : ""}`;
  const pct = isImporting ? 100 : Math.min(100, Math.max(0, entry.percent));

  return (
    <div className="mt-auto space-y-1.5">
      <div className="text-[11px] text-we-muted truncate">{label}</div>
      <div className="h-1.5 bg-we-hover rounded overflow-hidden">
        <div
          className={["h-full bg-we-teal transition-all", isImporting ? "animate-pulse" : ""].join(" ")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  Check,
  ExternalLink,
  Link2,
  Loader2,
  Music,
  Pause,
  Play,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { startDragWithSource } from "@/lib/customDrag";
import { stockDragSource } from "@/lib/stock";
import {
  formatAudioDuration,
  loadMoreAudio,
  searchAudio,
  type AudioPage,
  type AudioSource,
  type StockAudio,
} from "@/lib/stockAudio";
import { useDownloads, type DownloadEntry } from "@/state/downloads";
import { useIntegrations } from "@/state/integrations";

// Stock audio browser. Searches Freesound + Jamendo in parallel and shows a
// unified list. Click a row to preview (single audio element, one preview at
// a time), drag a row to add to the timeline (downloads on drop).

export function AudioPanel() {
  const loaded = useIntegrations((s) => s.loaded);
  const [showSetup, setShowSetup] = useState(false);

  if (!loaded) {
    return <div className="flex-1 grid place-items-center text-sm text-we-muted">Loading…</div>;
  }

  // NCS works without any API keys (via yt-dlp), so no setup wall — show the
  // search immediately. Users can open Sources to add Freesound/Jamendo keys
  // when they want more results.
  if (showSetup) {
    return <SetupForm onDone={() => setShowSetup(false)} />;
  }

  return <SearchView onOpenSettings={() => setShowSetup(true)} />;
}

// ── Setup ──

function SetupForm({ onDone }: { onDone: () => void }) {
  const freesoundKey = useIntegrations((s) => s.freesoundApiKey);
  const jamendoKey = useIntegrations((s) => s.jamendoApiKey);
  const setFreesoundKey = useIntegrations((s) => s.setFreesoundApiKey);
  const setJamendoKey = useIntegrations((s) => s.setJamendoApiKey);

  const [fs, setFs] = useState(freesoundKey ?? "");
  const [jm, setJm] = useState(jamendoKey ?? "");

  const fsTrim = fs.trim();
  const jmTrim = jm.trim();
  const canContinue = Boolean(fsTrim || jmTrim);

  const onSave = async () => {
    await setFreesoundKey(fsTrim || null);
    await setJamendoKey(jmTrim || null);
    onDone();
  };

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-5 text-sm">
      <div className="flex items-center gap-2 text-we-ink">
        <Music className="w-5 h-5 text-we-teal" />
        <h2 className="text-base font-medium">Stock audio sources</h2>
      </div>

      <p className="text-we-muted">
        WeEdit can search across multiple free audio APIs at once. Set up either
        or both — search will work with whichever you provide.
      </p>

      <div className="rounded-lg border border-we-border p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <strong className="text-we-ink">Freesound</strong>
          <span className="text-[11px] text-we-muted">Sound effects + ambient · free</span>
        </div>
        <ol className="list-decimal pl-5 text-[12px] text-we-muted space-y-1">
          <li>
            Sign up at{" "}
            <button
              onClick={() => void shellOpen("https://freesound.org/home/login/")}
              className="text-we-teal hover:underline"
            >
              freesound.org
            </button>
            .
          </li>
          <li>
            Visit{" "}
            <button
              onClick={() => void shellOpen("https://freesound.org/apiv2/apply/")}
              className="text-we-teal hover:underline"
            >
              freesound.org/apiv2/apply
            </button>
            and create an API credential.
          </li>
          <li>Copy the <em>Client secret</em> (a.k.a. API key) and paste it below.</li>
        </ol>
        <input
          type="text"
          value={fs}
          onChange={(e) => setFs(e.target.value)}
          placeholder="Freesound API key"
          className="we-input"
        />
      </div>

      <div className="rounded-lg border border-we-border p-4 space-y-3">
        <div className="flex items-baseline justify-between">
          <strong className="text-we-ink">Jamendo</strong>
          <span className="text-[11px] text-we-muted">Music tracks · free</span>
        </div>
        <ol className="list-decimal pl-5 text-[12px] text-we-muted space-y-1">
          <li>
            Sign up at{" "}
            <button
              onClick={() => void shellOpen("https://devportal.jamendo.com/")}
              className="text-we-teal hover:underline"
            >
              devportal.jamendo.com
            </button>
            .
          </li>
          <li>Create a new app — any name + description works.</li>
          <li>Copy the <em>Client ID</em> and paste it below.</li>
        </ol>
        <input
          type="text"
          value={jm}
          onChange={(e) => setJm(e.target.value)}
          placeholder="Jamendo client ID"
          className="we-input"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button onClick={onDone} className="we-btn">Cancel</button>
        <button
          onClick={() => void onSave()}
          disabled={!canContinue}
          className="we-btn-primary disabled:opacity-50"
        >
          Save & continue
        </button>
      </div>
    </div>
  );
}

// ── Search view ──

function SearchView({ onOpenSettings }: { onOpenSettings: () => void }) {
  const freesoundKey = useIntegrations((s) => s.freesoundApiKey);
  const jamendoKey = useIntegrations((s) => s.jamendoApiKey);

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [page, setPage] = useState<AudioPage | null>(null);
  const [loading, setLoading] = useState(false);

  const doSearch = useCallback(
    async (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setLoading(true);
      try {
        const result = await searchAudio({ freesoundKey, jamendoKey, query: trimmed });
        setPage(result);
        setSubmitted(trimmed);
      } finally {
        setLoading(false);
      }
    },
    [freesoundKey, jamendoKey],
  );

  const doLoadMore = useCallback(async () => {
    if (!page || !submitted) return;
    setLoading(true);
    try {
      const more = await loadMoreAudio({
        freesoundKey,
        jamendoKey,
        query: submitted,
        next: page.next,
      });
      setPage((prev) =>
        prev
          ? {
              results: [...prev.results, ...more.results],
              next: more.next,
              errors: more.errors,
            }
          : more,
      );
    } finally {
      setLoading(false);
    }
  }, [page, submitted, freesoundKey, jamendoKey]);

  const hasMore = page && (page.next.freesound || page.next.jamendo);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-we-border bg-we-panel">
        <Music className="w-5 h-5 text-we-teal" />
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-we-ink">Stock audio</div>
          <div className="text-[11px] text-we-muted">
            {[
              freesoundKey ? "Freesound" : null,
              jamendoKey ? "Jamendo" : null,
              "NCS",
            ]
              .filter(Boolean)
              .join(" · ")}
            {" · "}drag a row onto an audio track
          </div>
        </div>
        <button onClick={onOpenSettings} className="we-btn" title="Manage API keys">
          <Settings className="w-4 h-4" /> Sources
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void doSearch(query);
        }}
        className="flex gap-2 px-4 py-3"
      >
        <div className="flex-1 relative">
          <Search className="w-4 h-4 text-we-muted absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search music + sfx (e.g. lo-fi beat, doorbell, crowd cheer)"
            className="we-input pl-9"
          />
        </div>
        <button type="submit" className="we-btn-primary" disabled={loading}>
          Search
        </button>
      </form>

      <UrlImporter />
      <ActiveDownloads />

      {page?.errors.freesound && (
        <div className="mx-4 my-1 px-3 py-2 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded">
          Freesound: {page.errors.freesound}
        </div>
      )}
      {page?.errors.jamendo && (
        <div className="mx-4 my-1 px-3 py-2 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded">
          Jamendo: {page.errors.jamendo}
        </div>
      )}
      {page?.errors.ncs && (
        <div className="mx-4 my-1 px-3 py-2 text-[11px] text-red-700 bg-red-50 border border-red-100 rounded">
          NCS: {page.errors.ncs}
        </div>
      )}

      <div className="flex-1 overflow-auto">
        {loading && !page ? (
          <div className="flex-1 grid place-items-center py-12 text-sm text-we-muted">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" />
              Searching{" "}
              {[
                freesoundKey ? "Freesound" : null,
                jamendoKey ? "Jamendo" : null,
                "NCS",
              ]
                .filter(Boolean)
                .join(" + ")}
              …
            </div>
          </div>
        ) : !page ? (
          <div className="flex-1 grid place-items-center py-12 text-sm text-we-muted">
            Type a search above to find music + sound effects.
          </div>
        ) : page.results.length === 0 ? (
          <div className="flex-1 grid place-items-center py-12 text-sm text-we-muted">
            No results for "{submitted}".
          </div>
        ) : (
          <ResultsList items={page.results} />
        )}

        {hasMore && (
          <div className="text-center py-4">
            <button onClick={() => void doLoadMore()} disabled={loading} className="we-btn">
              {loading ? "Loading…" : "Load more"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── URL importer (NCS via YouTube, SoundCloud, etc.) ──

function UrlImporter() {
  const start = useDownloads((s) => s.start);
  const [value, setValue] = useState("");
  const [touched, setTouched] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setTouched(true);
    const url = value.trim();
    if (!url || !/^https?:\/\//i.test(url)) return;
    setValue("");
    await start(url, "Audio from URL", { audioOnly: true });
  };

  return (
    <div className="border-y border-we-border bg-we-rail/60 px-4 py-3">
      <div className="flex items-center gap-2 mb-2">
        <Link2 className="w-4 h-4 text-we-teal" />
        <span className="text-xs font-medium text-we-ink">Download from URL</span>
        <span className="text-[11px] text-we-muted">
          NCS · YouTube · SoundCloud · Bandcamp · anything yt-dlp supports
        </span>
      </div>
      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=..."
          className="we-input flex-1"
        />
        <button type="submit" className="we-btn-primary">Download</button>
      </form>
      {touched && value && !/^https?:\/\//i.test(value.trim()) && (
        <div className="text-[11px] text-red-700 mt-1">Enter a full URL starting with http(s)://</div>
      )}
      <div className="text-[11px] text-we-muted mt-2 leading-5">
        Tip:{" "}
        <button
          onClick={() => void shellOpen("https://ncs.io/")}
          className="text-we-teal hover:underline"
        >
          browse NCS
        </button>{" "}
        for free-to-use tracks — copy a track's YouTube link, paste it here.{" "}
        <strong>NCS still requires credit</strong> (artist + track + NCS) in your video
        description per their license.
      </div>
    </div>
  );
}

function ActiveDownloads() {
  const byUrl = useDownloads((s) => s.byUrl);
  const entries = useMemo(() => Object.values(byUrl), [byUrl]);
  if (entries.length === 0) return null;
  return (
    <div className="border-b border-we-border bg-we-panel px-4 py-2 space-y-1.5">
      {entries.map((e) => (
        <DownloadRow key={e.id} entry={e} />
      ))}
    </div>
  );
}

function DownloadRow({ entry }: { entry: DownloadEntry }) {
  const dismiss = useDownloads((s) => s.dismiss);

  if (entry.status === "error") {
    return (
      <div className="flex items-start gap-2 rounded border border-red-200 bg-red-50 px-3 py-1.5 text-[11px] text-red-700">
        <span className="flex-1 truncate">{entry.error || "Download failed."}</span>
        <button onClick={() => dismiss(entry.url)} className="we-btn-ghost p-0.5">
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  if (entry.status === "complete") {
    return (
      <div className="flex items-center gap-2 rounded border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-[11px] text-emerald-800">
        <Check className="w-3 h-3" />
        <span className="flex-1 truncate" title={entry.filepath}>Added to library · {entry.title}</span>
        <button onClick={() => dismiss(entry.url)} className="we-btn-ghost p-0.5">
          <X className="w-3 h-3" />
        </button>
      </div>
    );
  }
  const pct = entry.status === "importing" ? 100 : Math.min(100, Math.max(0, entry.percent));
  const label =
    entry.status === "importing"
      ? "Importing…"
      : entry.status === "starting"
      ? "Starting…"
      : `${entry.percent.toFixed(1)}% · ${entry.speed ?? ""}${entry.eta ? ` · ETA ${entry.eta}` : ""}`;
  return (
    <div className="flex items-center gap-2 text-[11px] text-we-muted">
      <span className="truncate flex-1" title={entry.url}>{label}</span>
      <div className="w-32 h-1.5 bg-we-hover rounded overflow-hidden">
        <div
          className={["h-full bg-we-teal transition-all", entry.status === "importing" ? "animate-pulse" : ""].join(" ")}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

// ── Results list ──

function ResultsList({ items }: { items: StockAudio[] }) {
  // One <audio> element + module-level current uid so only one preview plays.
  const [playingUid, setPlayingUid] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // Stop preview when component unmounts (e.g. user switches tab).
  useEffect(() => {
    return () => {
      const a = audioRef.current;
      if (a) {
        a.pause();
        a.src = "";
      }
    };
  }, []);

  const togglePreview = (item: StockAudio) => {
    let el = audioRef.current;
    if (!el) {
      el = new Audio();
      el.preload = "none";
      el.addEventListener("ended", () => setPlayingUid(null));
      audioRef.current = el;
    }
    if (playingUid === item.uid) {
      el.pause();
      setPlayingUid(null);
      return;
    }
    el.src = item.previewUrl;
    el.currentTime = 0;
    el.play().then(() => setPlayingUid(item.uid)).catch((err) => {
      console.warn("Audio preview failed:", err);
      setPlayingUid(null);
    });
  };

  return (
    <ul className="divide-y divide-we-border">
      {items.map((item) => (
        <AudioRow
          key={item.uid}
          item={item}
          playing={playingUid === item.uid}
          onTogglePreview={() => togglePreview(item)}
        />
      ))}
    </ul>
  );
}

function AudioRow({
  item,
  playing,
  onTogglePreview,
}: {
  item: StockAudio;
  playing: boolean;
  onTogglePreview: () => void;
}) {
  // NCS rows download via yt-dlp (audio_only); everything else uses
  // plain http_download. Both paths funnel through the custom drag controller.
  const onMouseDown = (e: React.MouseEvent) => {
    if (item.ytdlpUrl) {
      startDragWithSource(e, {
        kind: "audio",
        label: `${item.title} · ${item.author}`,
        resolve: () =>
          useDownloads
            .getState()
            .start(item.ytdlpUrl!, `${item.author} · ${item.title}`, { audioOnly: true }),
      });
    } else {
      startDragWithSource(
        e,
        stockDragSource({
          kind: "audio",
          label: `${item.title} · ${item.author}`,
          url: item.downloadUrl ?? item.previewUrl,
          suggestedName: `${item.source}-${item.uid}`,
          ext: "mp3",
        }),
      );
    }
  };

  // NCS doesn't expose a direct MP3 — clicking "preview" opens the YouTube
  // page in the user's browser instead of trying to feed it to <audio>.
  const isYoutubePreview = item.source === "ncs";

  return (
    <li
      className="flex items-center gap-3 px-5 py-2.5 hover:bg-we-hover cursor-grab active:cursor-grabbing select-none"
      onMouseDown={onMouseDown}
      title={`${item.title} — drag onto an audio track`}
    >
      {item.thumbnail ? (
        <img
          src={item.thumbnail}
          alt=""
          draggable={false}
          className="w-14 h-8 rounded object-cover shrink-0 bg-we-hover pointer-events-none"
        />
      ) : null}

      <button
        onClick={(e) => {
          e.stopPropagation();
          if (isYoutubePreview) {
            void shellOpen(item.previewUrl);
          } else {
            onTogglePreview();
          }
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className={[
          "w-8 h-8 rounded-full grid place-items-center shrink-0 transition-colors",
          playing
            ? "bg-we-teal text-white"
            : "bg-we-hover text-we-ink hover:bg-we-hover",
        ].join(" ")}
        aria-label={
          isYoutubePreview
            ? "Open on YouTube to preview"
            : playing
            ? "Pause preview"
            : "Play preview"
        }
        title={isYoutubePreview ? "Open on YouTube to preview" : "Play preview"}
      >
        {isYoutubePreview ? (
          <ExternalLink className="w-3.5 h-3.5" />
        ) : playing ? (
          <Pause className="w-4 h-4" />
        ) : (
          <Play className="w-4 h-4 ml-0.5" />
        )}
      </button>

      <div className="flex-1 min-w-0">
        <div className="text-sm text-we-ink truncate">{item.title}</div>
        <div className="text-[11px] text-we-muted truncate">
          {item.author} · <SourceBadge source={item.source} />
        </div>
      </div>

      <span className="text-[11px] text-we-muted tabular-nums shrink-0">
        {formatAudioDuration(item.durationSec)}
      </span>

      <button
        onClick={(e) => {
          e.stopPropagation();
          void shellOpen(item.detailUrl);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        className="we-btn-ghost p-1"
        title="Open on source site"
        aria-label="Open detail page"
      >
        <ExternalLink className="w-3.5 h-3.5" />
      </button>
    </li>
  );
}

function SourceBadge({ source }: { source: AudioSource }) {
  const config: Record<AudioSource, { label: string; tone: string }> = {
    freesound: { label: "Freesound", tone: "bg-amber-100 text-amber-800" },
    jamendo:   { label: "Jamendo",   tone: "bg-emerald-100 text-emerald-800" },
    ncs:       { label: "NCS",       tone: "bg-indigo-100 text-indigo-800" },
  };
  const { label, tone } = config[source];
  return (
    <span className={["inline-block px-1.5 rounded text-[10px] font-medium", tone].join(" ")}>
      {label}
    </span>
  );
}

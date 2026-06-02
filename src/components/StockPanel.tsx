import { open as shellOpen } from "@tauri-apps/plugin-shell";
import {
  Film,
  Image as ImageIcon,
  Loader2,
  LogOut,
  Search,
  Sparkles,
} from "lucide-react";
import { useCallback, useState } from "react";
import { startDragWithSource } from "@/lib/customDrag";
import {
  bestVideoFile,
  describeVideo,
  searchPhotos,
  searchVideos,
  type PexelsPhoto,
  type PexelsVideo,
} from "@/lib/pexels";
import { stockDragSource } from "@/lib/stock";
import { useIntegrations } from "@/state/integrations";

// Pexels stock browser. The `kind` prop is set by the parent based on which
// sidebar tab is active — Videos shows the video search, Images shows the
// photo search. They share one Pexels API key stored in app config.
export function StockPanel({ kind }: { kind: "video" | "image" }) {
  const loaded = useIntegrations((s) => s.loaded);
  const apiKey = useIntegrations((s) => s.pexelsApiKey);
  const setApiKey = useIntegrations((s) => s.setPexelsApiKey);

  if (!loaded) {
    return <div className="flex-1 grid place-items-center text-sm text-we-muted">Loading…</div>;
  }

  if (!apiKey) {
    return <Setup kind={kind} onSave={(k) => setApiKey(k)} />;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 py-3 border-b border-we-border bg-we-panel">
        {kind === "video" ? (
          <Film className="w-5 h-5 text-we-teal" />
        ) : (
          <ImageIcon className="w-5 h-5 text-we-teal" />
        )}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-we-ink">
            Stock {kind === "video" ? "videos" : "images"}
          </div>
          <div className="text-[11px] text-we-muted">
            Pexels · drag results onto a track
          </div>
        </div>
        <button onClick={() => void setApiKey(null)} className="we-btn" title="Reset Pexels API key">
          <LogOut className="w-4 h-4" />
          Reset key
        </button>
      </div>

      <div className="flex-1 overflow-auto">
        {kind === "video" ? <VideoSearch apiKey={apiKey} /> : <ImageSearch apiKey={apiKey} />}
      </div>
    </div>
  );
}

// ── Setup ──

function Setup({
  kind,
  onSave,
}: {
  kind: "video" | "image";
  onSave: (key: string) => void | Promise<void>;
}) {
  const [value, setValue] = useState("");
  const trimmed = value.trim();
  return (
    <div className="p-6 max-w-2xl mx-auto space-y-4">
      <div className="flex items-center gap-2 text-we-ink">
        <Sparkles className="w-5 h-5 text-we-teal" />
        <h2 className="text-base font-medium">
          Connect to Pexels for stock {kind === "video" ? "videos" : "images"}
        </h2>
      </div>

      <div className="text-sm text-we-ink leading-6">
        Stock search uses the free Pexels API. One key covers both videos and images.
        <ol className="list-decimal pl-6 mt-2 space-y-1 text-we-muted">
          <li>
            Go to{" "}
            <button
              onClick={() => void shellOpen("https://www.pexels.com/api/")}
              className="text-we-teal hover:underline"
            >
              pexels.com/api
            </button>{" "}
            and click "Get Started".
          </li>
          <li>Sign in (or create a free account).</li>
          <li>Generate an API key — fill in any project description.</li>
          <li>Copy the key and paste it below.</li>
        </ol>
        <p className="text-[11px] text-we-muted mt-2">
          Free tier: 200 requests/hour, 20,000/month. Plenty for personal use.
        </p>
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium text-we-ink">Pexels API key</label>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="paste the key here"
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

// ── Search bar primitive ──

function SearchBar({
  value,
  onChange,
  onSubmit,
  placeholder,
}: {
  value: string;
  onChange: (s: string) => void;
  onSubmit: () => void;
  placeholder: string;
}) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="flex gap-2 px-4 py-3"
    >
      <div className="flex-1 relative">
        <Search className="w-4 h-4 text-we-muted absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="we-input pl-9"
        />
      </div>
      <button type="submit" className="we-btn-primary">Search</button>
    </form>
  );
}

// ── Video search ──

function VideoSearch({ apiKey }: { apiKey: string }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<PexelsVideo[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (q: string, page = 1, append = false) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setLoading(true);
      setError(null);
      try {
        const { videos, nextPage } = await searchVideos(apiKey, trimmed, page);
        setResults((prev) => (append ? [...prev, ...videos] : videos));
        setNextPage(nextPage);
        setSubmitted(trimmed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [apiKey],
  );

  return (
    <div className="flex flex-col">
      <SearchBar
        value={query}
        onChange={setQuery}
        onSubmit={() => void search(query, 1, false)}
        placeholder="Search Pexels video (e.g. city night, ocean waves, gaming setup)"
      />

      {error && (
        <div className="mx-4 my-2 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded">
          {error}
        </div>
      )}

      {loading && results.length === 0 ? (
        <LoadingState label={`Searching "${query}"…`} />
      ) : results.length === 0 ? (
        submitted ? (
          <EmptyState label={`No videos for "${submitted}".`} />
        ) : (
          <EmptyState label="Type a search above to find stock footage." />
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 p-4">
          {results.map((v) => (
            <VideoCard key={v.id} video={v} />
          ))}
        </div>
      )}

      {nextPage && results.length > 0 && (
        <div className="text-center py-4">
          <button
            onClick={() => void search(submitted, nextPage, true)}
            disabled={loading}
            className="we-btn"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function VideoCard({ video }: { video: PexelsVideo }) {
  const startDrag = (e: React.MouseEvent) => {
    const best = bestVideoFile(video);
    if (!best) return;
    const source = stockDragSource({
      kind: "video",
      label: `Pexels · ${video.user.name}`,
      url: best.link,
      suggestedName: `pexels-${video.id}`,
      ext: "mp4",
    });
    startDragWithSource(e, source);
  };

  return (
    <div
      className="rounded-lg border border-we-border overflow-hidden bg-we-panel hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing select-none"
      title={`${video.user.name} · ${describeVideo(video)} — drag onto a video track`}
      onMouseDown={startDrag}
    >
      <div className="aspect-video bg-slate-900 relative overflow-hidden pointer-events-none">
        <img
          src={video.image}
          alt=""
          draggable={false}
          className="w-full h-full object-cover"
        />
        <span className="absolute bottom-1 right-1 px-1.5 py-0.5 rounded bg-black/70 text-white text-[10px] tabular-nums">
          {video.duration}s
        </span>
      </div>
      <div className="px-3 py-2">
        <div className="text-xs text-we-ink truncate">{describeVideo(video)}</div>
        <div className="text-[11px] text-we-muted truncate">by {video.user.name}</div>
      </div>
    </div>
  );
}

// ── Image search ──

function ImageSearch({ apiKey }: { apiKey: string }) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [results, setResults] = useState<PexelsPhoto[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(
    async (q: string, page = 1, append = false) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      setLoading(true);
      setError(null);
      try {
        const { photos, nextPage } = await searchPhotos(apiKey, trimmed, page);
        setResults((prev) => (append ? [...prev, ...photos] : photos));
        setNextPage(nextPage);
        setSubmitted(trimmed);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [apiKey],
  );

  return (
    <div className="flex flex-col">
      <SearchBar
        value={query}
        onChange={setQuery}
        onSubmit={() => void search(query, 1, false)}
        placeholder="Search Pexels image (e.g. forest, neon sign, esports arena)"
      />

      {error && (
        <div className="mx-4 my-2 px-3 py-2 text-xs text-red-700 bg-red-50 border border-red-100 rounded">
          {error}
        </div>
      )}

      {loading && results.length === 0 ? (
        <LoadingState label={`Searching "${query}"…`} />
      ) : results.length === 0 ? (
        submitted ? (
          <EmptyState label={`No images for "${submitted}".`} />
        ) : (
          <EmptyState label="Type a search above to find stock photography." />
        )
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-3 p-4">
          {results.map((p) => (
            <PhotoCard key={p.id} photo={p} />
          ))}
        </div>
      )}

      {nextPage && results.length > 0 && (
        <div className="text-center py-4">
          <button
            onClick={() => void search(submitted, nextPage, true)}
            disabled={loading}
            className="we-btn"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        </div>
      )}
    </div>
  );
}

function PhotoCard({ photo }: { photo: PexelsPhoto }) {
  const startDrag = (e: React.MouseEvent) => {
    const source = stockDragSource({
      kind: "image",
      label: `Pexels · ${photo.photographer}`,
      url: photo.src.large2x,
      suggestedName: `pexels-${photo.id}`,
      ext: "jpg",
    });
    startDragWithSource(e, source);
  };

  return (
    <div
      className="rounded-lg border border-we-border overflow-hidden bg-we-panel hover:shadow-md transition-shadow cursor-grab active:cursor-grabbing select-none"
      title={`${photo.alt || photo.photographer} — drag onto a video track`}
      onMouseDown={startDrag}
    >
      <div className="aspect-video bg-slate-900 relative overflow-hidden pointer-events-none">
        <img
          src={photo.src.medium}
          alt=""
          draggable={false}
          className="w-full h-full object-cover"
        />
      </div>
      <div className="px-2 py-1.5">
        <div className="text-[11px] text-we-muted truncate">by {photo.photographer}</div>
      </div>
    </div>
  );
}

// ── Misc states ──

function LoadingState({ label }: { label: string }) {
  return (
    <div className="flex-1 grid place-items-center py-12 text-sm text-we-muted">
      <div className="flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" />
        {label}
      </div>
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex-1 grid place-items-center py-12 text-sm text-we-muted">{label}</div>
  );
}

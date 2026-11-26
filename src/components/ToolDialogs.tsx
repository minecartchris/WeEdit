import { AudioLines, Captions, Download, Loader2, MessageSquareText } from "lucide-react";
import { useEffect, useState } from "react";
import { Modal } from "@/components/ui/Modal";
import {
  CAPTION_MODEL_MB,
  DEFAULT_SILENCE,
  audioClips,
  captionModelReady,
  detectSilence,
  downloadCaptionModel,
  findWhisper,
  generateCaptions,
  useTools,
  type SilenceOptions,
} from "@/lib/aiTools";
import {
  findTwitchDownloader,
  guessVodId,
  parseVodId,
  runTwitchChat,
  useTwitchChatDialog,
} from "@/lib/twitchChat";
import { useEditor } from "@/state/editor";
import { usePrefs } from "@/state/prefs";

/** Both tool dialogs; mounted once in App and opened through `useTools`. */
export function ToolDialogs() {
  return (
    <>
      <SilenceDialog />
      <CaptionsDialog />
      <TwitchChatDialog />
    </>
  );
}

function SilenceDialog() {
  const ids = useTools((s) => s.silenceFor);
  const close = useTools((s) => s.close);
  const [opts, setOpts] = useState<SilenceOptions>(DEFAULT_SILENCE);
  const [ranges, setRanges] = useState<Array<[number, number]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setRanges(null);
    setError(null);
  }, [ids, opts]);

  if (!ids) return null;
  const count = audioClips(ids).length;
  const total = ranges?.reduce((sum, [a, b]) => sum + (b - a), 0) ?? 0;

  const detect = async () => {
    setBusy(true);
    setError(null);
    try {
      setRanges(await detectSilence(ids, opts));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  const apply = () => {
    if (ranges && ranges.length) useEditor.getState().rippleDeleteRanges(ranges);
    close();
  };
  const field = (label: string, key: keyof SilenceOptions, min: number, max: number, step: number, unit: string) => (
    <label className="flex items-center gap-3 text-sm text-we-ink">
      <span className="w-40 shrink-0">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={opts[key]}
        onChange={(e) => setOpts({ ...opts, [key]: Number(e.target.value) })}
        className="flex-1 accent-we-teal"
      />
      <span className="w-16 text-right tabular-nums text-xs text-we-muted">
        {opts[key]}
        {unit}
      </span>
    </label>
  );

  return (
    <Modal open onClose={close} title="Remove silence" width="520px">
      <div className="p-5 flex flex-col gap-4">
        <p className="text-xs text-we-muted leading-5">
          Finds pauses in the {count === 1 ? "selected clip's" : `${count} selected clips'`} audio and cuts them out of
          the whole timeline, closing the gaps — every track moves together, so video, detached audio and titles stay
          in sync. Undo puts it all back.
        </p>
        {field("Silence is quieter than", "noiseDb", -60, -15, 1, " dB")}
        {field("Only pauses longer than", "minSilenceSec", 0.2, 5, 0.1, " s")}
        {field("Keep around each cut", "paddingSec", 0, 1, 0.05, " s")}
        {error && <p className="text-xs text-red-600">{error}</p>}
        {ranges && (
          <p className="text-sm text-we-ink">
            {ranges.length === 0
              ? "No pauses found with these settings."
              : `Found ${ranges.length} pause${ranges.length === 1 ? "" : "s"} — ${total.toFixed(1)} s will be cut.`}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button onClick={close} className="we-btn">
            Cancel
          </button>
          {ranges && ranges.length > 0 ? (
            <button onClick={apply} className="we-btn-primary">
              Remove {ranges.length} pause{ranges.length === 1 ? "" : "s"}
            </button>
          ) : (
            <button onClick={() => void detect()} disabled={busy || count === 0} className="we-btn-primary disabled:opacity-50">
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <AudioLines className="w-4 h-4" />}
              {busy ? "Listening…" : "Find pauses"}
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function CaptionsDialog() {
  const ids = useTools((s) => s.captionsFor);
  const close = useTools((s) => s.close);
  const language = usePrefs((s) => s.captionLanguage);
  const setPref = usePrefs((s) => s.setPref);
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  const [whisper, setWhisper] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!ids) return;
    setResult(null);
    setError(null);
    void captionModelReady().then(setModelReady);
    void findWhisper()
      .then(setWhisper)
      .catch(() => setWhisper(null));
  }, [ids]);

  if (!ids) return null;
  const count = audioClips(ids).length;

  const getModel = async () => {
    setBusy(`Downloading the speech model (${CAPTION_MODEL_MB} MB)…`);
    setError(null);
    try {
      await downloadCaptionModel();
      setModelReady(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };
  const run = async () => {
    setError(null);
    try {
      const n = await generateCaptions(ids, (done, total) =>
        setBusy(total > 1 ? `Transcribing clip ${Math.min(done + 1, total)} of ${total}…` : "Transcribing…"),
      );
      setResult(n === 0 ? "No speech found." : `Added ${n} captions on a new "Captions" track.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={close} title="Auto-captions" width="520px">
      <div className="p-5 flex flex-col gap-4">
        <p className="text-xs text-we-muted leading-5">
          Transcribes the {count === 1 ? "selected clip" : `${count} selected clips`} on this computer with whisper.cpp
          (nothing is uploaded) and adds each line as an editable text clip, timed to the speech.
        </p>

        <div className="flex flex-col gap-1.5 text-sm">
          <div className="flex items-center gap-2">
            <span className="w-28 text-we-muted">Speech engine</span>
            {whisper === undefined ? (
              <span className="text-we-muted">Checking…</span>
            ) : whisper ? (
              <span className="text-we-ink truncate" title={whisper}>
                whisper.cpp found
              </span>
            ) : (
              <span className="text-red-600 text-xs">
                whisper.cpp not found — install it and set its path in Settings → Captions.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span className="w-28 text-we-muted">Speech model</span>
            {modelReady == null ? (
              <span className="text-we-muted">Checking…</span>
            ) : modelReady ? (
              <span className="text-we-ink">Ready</span>
            ) : (
              <button onClick={() => void getModel()} disabled={!!busy} className="we-btn text-xs py-1 disabled:opacity-50">
                <Download className="w-3.5 h-3.5" /> Download ({CAPTION_MODEL_MB} MB)
              </button>
            )}
          </div>
          <label className="flex items-center gap-2">
            <span className="w-28 text-we-muted">Language</span>
            <select value={language} onChange={(e) => setPref("captionLanguage", e.target.value)} className="we-input py-1 w-auto">
              <option value="auto">Detect automatically</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="de">German</option>
              <option value="fr">French</option>
              <option value="pt">Portuguese</option>
              <option value="ja">Japanese</option>
            </select>
          </label>
        </div>

        {busy && (
          <p className="text-sm text-we-ink flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" /> {busy}
          </p>
        )}
        {result && <p className="text-sm text-we-ink">{result}</p>}
        {error && <p className="text-xs text-red-600 whitespace-pre-wrap">{error}</p>}

        <div className="flex justify-end gap-2">
          <button onClick={close} className="we-btn">
            {result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <button
              onClick={() => void run()}
              disabled={!!busy || !modelReady || !whisper || count === 0}
              className="we-btn-primary disabled:opacity-50"
            >
              <Captions className="w-4 h-4" /> Generate captions
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

function TwitchChatDialog() {
  const clipId = useTwitchChatDialog((s) => s.clipId);
  const close = useTwitchChatDialog((s) => s.close);
  const [vod, setVod] = useState("");
  const [overlay, setOverlay] = useState(true);
  const [highlights, setHighlights] = useState(true);
  const [tool, setTool] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!clipId) return;
    const { clips, media } = useEditor.getState();
    const c = clips[clipId];
    const m = c && c.kind !== "text" ? media.find((x) => x.id === c.mediaId) : undefined;
    setVod(m ? guessVodId(m.name) : "");
    setResult(null);
    setError(null);
    void findTwitchDownloader()
      .then(setTool)
      .catch(() => setTool(null));
  }, [clipId]);

  if (!clipId) return null;
  const vodId = parseVodId(vod);

  const run = async () => {
    if (!vodId) return;
    setError(null);
    try {
      setResult(await runTwitchChat(clipId, { vodId, overlay, highlights, onStatus: setBusy }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open onClose={close} title="Twitch chat" width="520px">
      <div className="p-5 flex flex-col gap-4 text-sm">
        <p className="text-xs text-we-muted leading-5">
          Uses this VOD's chat for the part of it this clip covers: a chat-replay overlay that stays in sync with the
          clip, and markers where chat suddenly got busy — a quick way to find the highlights.
        </p>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-we-muted">VOD link or id</span>
          <input
            value={vod}
            onChange={(e) => setVod(e.target.value)}
            placeholder="https://www.twitch.tv/videos/2312345678"
            className="we-input font-mono"
          />
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={overlay} onChange={(e) => setOverlay(e.target.checked)} className="accent-we-teal" />
          Add a chat-replay overlay above the clip
        </label>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={highlights} onChange={(e) => setHighlights(e.target.checked)} className="accent-we-teal" />
          Mark chat spikes as highlight markers
        </label>
        {tool === null && (
          <p className="text-xs text-red-600">
            TwitchDownloaderCLI not found — get it from github.com/lay295/TwitchDownloader/releases and set its path in
            Settings → Twitch chat.
          </p>
        )}
        {busy && (
          <p className="flex items-center gap-2 text-we-ink">
            <Loader2 className="w-4 h-4 animate-spin" /> {busy}
          </p>
        )}
        {result && <p className="text-we-ink">{result}</p>}
        {error && <p className="text-xs text-red-600 whitespace-pre-wrap">{error}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={close} className="we-btn">
            {result ? "Done" : "Cancel"}
          </button>
          {!result && (
            <button
              onClick={() => void run()}
              disabled={!!busy || !vodId || !tool || (!overlay && !highlights)}
              className="we-btn-primary disabled:opacity-50"
            >
              <MessageSquareText className="w-4 h-4" /> Go
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}

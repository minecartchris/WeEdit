import { ffprobeAudioStreams } from "@/lib/ffmpeg";
import { isTauri } from "@/lib/platform";
import { useEditor } from "@/state/editor";

// Auto-labelling audio tracks (#52) reads the stream names ffprobe gave us at
// import. Media imported before handler names were probed (where OBS keeps its
// track names) only has a language tag — usually "und" — so re-read the names
// once before labelling. Cheap: ffprobe only, no re-extraction.

async function refreshStreamNames(): Promise<void> {
  if (!isTauri()) return;
  const stale = useEditor
    .getState()
    .media.filter(
      (m) =>
        m.audioTracks &&
        m.audioTracks.length > 0 &&
        m.audioTracks.every((t) => !t.title && t.handlerName === undefined),
    );
  if (stale.length === 0) return;

  const fresh = new Map<string, Map<number, { title?: string; handlerName: string }>>();
  await Promise.all(
    stale.map(async (m) => {
      try {
        const streams = await ffprobeAudioStreams(m.src);
        fresh.set(
          m.id,
          // "" marks "probed, nothing there" so we don't re-probe every time.
          new Map(streams.map((s) => [s.index, { title: s.title, handlerName: s.handlerName ?? "" }])),
        );
      } catch (err) {
        console.warn(`Couldn't re-read audio stream names for ${m.name}:`, err);
      }
    }),
  );
  if (fresh.size === 0) return;

  useEditor.setState((s) => ({
    media: s.media.map((m) => {
      const byIndex = fresh.get(m.id);
      if (!byIndex || !m.audioTracks) return m;
      return {
        ...m,
        audioTracks: m.audioTracks.map((t) => {
          const f = byIndex.get(t.index);
          return f ? { ...t, title: t.title ?? f.title, handlerName: f.handlerName } : t;
        }),
      };
    }),
  }));
}

/** Refresh stream names where needed, then auto-label (one track, or all audio tracks). */
export async function autoLabelAudioTracks(trackId?: string): Promise<number> {
  await refreshStreamNames();
  return useEditor.getState().autoLabelAudioTracks(trackId);
}

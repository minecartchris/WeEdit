import { FolderOpen } from "lucide-react";
import { isTauri } from "@/lib/platform";
import { pickCollabMediaDir, usePrefs } from "@/state/prefs";

/**
 * Where media fetched from collaborators lands (#55): WeEdit's own cache folder
 * (the default), or a folder of your choosing where the files are saved under
 * their real names and stay put after the session. Desktop only — the browser
 * editor keeps downloads in browser storage.
 */
export function CollabDownloadSetting({ compact = false }: { compact?: boolean }) {
  const useTemp = usePrefs((s) => s.collabMediaTemp);
  const dir = usePrefs((s) => s.collabMediaDir);
  const setUseTemp = usePrefs((s) => s.setCollabMediaTemp);

  if (!isTauri()) return null;

  const onToggle = async (temp: boolean) => {
    setUseTemp(temp);
    // Turning the temp folder off with nowhere to save to: ask right away.
    if (!temp && !dir) {
      const picked = await pickCollabMediaDir();
      if (!picked) setUseTemp(true);
    }
  };

  return (
    <div className={compact ? "flex flex-col gap-1.5" : "flex flex-col gap-2"}>
      <label className="flex items-start gap-2 text-sm text-we-ink cursor-pointer">
        <input
          type="checkbox"
          checked={useTemp}
          onChange={(e) => void onToggle(e.target.checked)}
          className="mt-0.5 accent-we-teal"
        />
        <span>
          Keep downloaded media in a temporary folder
          <span className="block text-[11px] text-we-muted">
            {useTemp
              ? "Files from collaborators stay in WeEdit's cache."
              : "Files from collaborators are saved under their real names in the folder below."}
          </span>
        </span>
      </label>
      {!useTemp && (
        <div className="flex items-center gap-2 pl-6">
          <code
            className="flex-1 min-w-0 truncate rounded bg-we-panel border border-we-border px-2 py-1 text-[11px] text-we-ink"
            title={dir ?? undefined}
          >
            {dir ?? "No folder chosen"}
          </code>
          <button onClick={() => void pickCollabMediaDir()} className="we-btn shrink-0 text-xs py-1">
            <FolderOpen className="w-3.5 h-3.5" />
            {dir ? "Change…" : "Choose…"}
          </button>
        </div>
      )}
    </div>
  );
}

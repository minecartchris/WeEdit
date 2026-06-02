import { useEffect } from "react";
import { Inspector } from "@/components/Inspector";
import { MediaLibrary } from "@/components/MediaLibrary";
import { Preview } from "@/components/Preview";
import { Sidebar } from "@/components/Sidebar";
import { Timeline } from "@/components/Timeline";
import { TopBar } from "@/components/TopBar";
import { Splitter } from "@/components/ui/Splitter";
import { useAutoSave } from "@/hooks/useAutoSave";
import { usePlayback } from "@/hooks/usePlayback";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useIntegrations } from "@/state/integrations";
import { useLibrary } from "@/state/library";
import { usePrefs } from "@/state/prefs";

export default function App() {
  useShortcuts();
  useAutoSave();
  usePlayback();

  const loadIntegrations = useIntegrations((s) => s.load);
  const loadPrefs = usePrefs((s) => s.load);
  const loadLibrary = useLibrary((s) => s.load);
  useEffect(() => {
    void loadPrefs().catch((err) => console.error("Failed to load prefs:", err));
    void loadLibrary().catch((err) => console.error("Failed to load library:", err));
    void loadIntegrations().catch((err) => console.error("Failed to load integrations:", err));
  }, [loadIntegrations, loadPrefs, loadLibrary]);

  // Resizable panel sizes (persisted in prefs). The Inspector + its splitter
  // are mounted in a later phase; the media library and timeline are resizable
  // now since the media panel being oversized was the main complaint.
  const libraryPx = usePrefs((s) => s.panelSizes.libraryPx);
  const inspectorPx = usePrefs((s) => s.panelSizes.inspectorPx);
  const timelinePx = usePrefs((s) => s.panelSizes.timelinePx);
  const setPanelSize = usePrefs((s) => s.setPanelSize);
  const savePanelSizes = usePrefs((s) => s.savePanelSizes);

  return (
    <div className="h-full w-full flex flex-col">
      <TopBar />
      <main className="flex-1 min-h-0 flex">
        <Sidebar />
        <div style={{ width: libraryPx }} className="shrink-0 min-h-0 min-w-0 flex">
          <MediaLibrary />
        </div>
        <Splitter
          axis="x"
          value={libraryPx}
          min={240}
          max={720}
          onChange={(v) => setPanelSize("libraryPx", v)}
          onCommit={savePanelSizes}
        />
        <Preview />
        <Splitter
          axis="x"
          invert
          value={inspectorPx}
          min={220}
          max={560}
          onChange={(v) => setPanelSize("inspectorPx", v)}
          onCommit={savePanelSizes}
        />
        <div style={{ width: inspectorPx }} className="shrink-0 min-h-0 min-w-0 flex">
          <Inspector />
        </div>
      </main>
      <Splitter
        axis="y"
        invert
        value={timelinePx}
        min={140}
        max={640}
        onChange={(v) => setPanelSize("timelinePx", v)}
        onCommit={savePanelSizes}
      />
      <div style={{ height: timelinePx }} className="shrink-0 min-h-0 flex">
        <Timeline />
      </div>
    </div>
  );
}

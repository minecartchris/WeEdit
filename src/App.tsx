import { useEffect } from "react";
import { Inspector } from "@/components/Inspector";
import { MediaLibrary } from "@/components/MediaLibrary";
import { CollabChat } from "@/components/CollabChat";
import { MediaSyncIndicator } from "@/components/MediaSyncIndicator";
import { RemoteExportPrompts } from "@/components/RemoteExport";
import { SessionBanner } from "@/components/SessionBanner";
import { ToolDialogs } from "@/components/ToolDialogs";
import { useLocalProxies } from "@/lib/proxy";
import { Preview } from "@/components/Preview";
import { Sidebar } from "@/components/Sidebar";
import { Timeline } from "@/components/Timeline";
import { TopBar } from "@/components/TopBar";
import { WebBanner } from "@/components/WebBanner";
import { Splitter } from "@/components/ui/Splitter";
import { useAutoSave } from "@/hooks/useAutoSave";
import { usePlayback } from "@/hooks/usePlayback";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useMissingMediaWatcher } from "@/state/missingMedia";
import { useIntegrations } from "@/state/integrations";
import { initInvites } from "@/lib/invites";
import { maybeSendUsagePing } from "@/lib/usage";
import { useLibrary } from "@/state/library";
import { usePrefs } from "@/state/prefs";

export default function App() {
  useShortcuts();
  useAutoSave();
  usePlayback();
  useMissingMediaWatcher();
  useLocalProxies();

  const loadIntegrations = useIntegrations((s) => s.load);
  const loadPrefs = usePrefs((s) => s.load);
  const loadLibrary = useLibrary((s) => s.load);
  useEffect(() => {
    void loadPrefs()
      .catch((err) => console.error("Failed to load prefs:", err))
      // After prefs, so a user who opted out is never counted.
      .then(() => {
        void maybeSendUsagePing();
        void initInvites(); // after prefs: joining may need the download-folder pref
      });
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
      <WebBanner />
      <TopBar />
      <SessionBanner />
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
      <MediaSyncIndicator />
      <CollabChat />
      <ToolDialogs />
      <RemoteExportPrompts />
    </div>
  );
}

import { useEffect } from "react";
import { MediaLibrary } from "@/components/MediaLibrary";
import { Preview } from "@/components/Preview";
import { Sidebar } from "@/components/Sidebar";
import { Timeline } from "@/components/Timeline";
import { TopBar } from "@/components/TopBar";
import { useAutoSave } from "@/hooks/useAutoSave";
import { usePlayback } from "@/hooks/usePlayback";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useIntegrations } from "@/state/integrations";
import { usePrefs } from "@/state/prefs";

export default function App() {
  useShortcuts();
  useAutoSave();
  usePlayback();

  const loadIntegrations = useIntegrations((s) => s.load);
  const loadPrefs = usePrefs((s) => s.load);
  useEffect(() => {
    void loadPrefs().catch((err) => console.error("Failed to load prefs:", err));
    void loadIntegrations().catch((err) => console.error("Failed to load integrations:", err));
  }, [loadIntegrations, loadPrefs]);

  return (
    <div className="h-full w-full flex flex-col">
      <TopBar />
      <main className="flex-1 min-h-0 flex">
        <Sidebar />
        <MediaLibrary />
        <Preview />
      </main>
      <Timeline />
    </div>
  );
}

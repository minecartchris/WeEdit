import { create } from "zustand";
import {
  loadConfig,
  saveConfig,
  type AppConfig,
  type NasConnection,
  type TwitchConfig,
} from "@/lib/config";

interface IntegrationsState {
  twitch: TwitchConfig | null;
  nas: NasConnection[];
  ytdlpPath: string | null;
  ffmpegPath: string | null;
  pexelsApiKey: string | null;
  freesoundApiKey: string | null;
  jamendoApiKey: string | null;
  recentProjects: string[];
  loaded: boolean;

  load: () => Promise<void>;
  setTwitch: (cfg: TwitchConfig | null) => Promise<void>;
  upsertNas: (conn: NasConnection) => Promise<void>;
  removeNas: (id: string) => Promise<void>;
  setYtdlpPath: (path: string | null) => Promise<void>;
  setFfmpegPath: (path: string | null) => Promise<void>;
  setPexelsApiKey: (key: string | null) => Promise<void>;
  setFreesoundApiKey: (key: string | null) => Promise<void>;
  setJamendoApiKey: (key: string | null) => Promise<void>;
  pushRecentProject: (path: string) => Promise<void>;
  clearRecentProjects: () => Promise<void>;
}

interface ConfigSlice {
  twitch: TwitchConfig | null;
  nas: NasConnection[];
  ytdlpPath: string | null;
  ffmpegPath: string | null;
  pexelsApiKey: string | null;
  freesoundApiKey: string | null;
  jamendoApiKey: string | null;
  recentProjects: string[];
}

function toConfig(s: ConfigSlice): AppConfig {
  return {
    version: 1,
    twitch: s.twitch ?? undefined,
    nasConnections: s.nas,
    ytdlpPath: s.ytdlpPath ?? undefined,
    ffmpegPath: s.ffmpegPath ?? undefined,
    pexelsApiKey: s.pexelsApiKey ?? undefined,
    freesoundApiKey: s.freesoundApiKey ?? undefined,
    jamendoApiKey: s.jamendoApiKey ?? undefined,
    recentProjects: s.recentProjects.length > 0 ? s.recentProjects : undefined,
  };
}

const RECENT_PROJECTS_MAX = 10;

// Snapshot of the slice we persist — used by every mutator so adding a new
// key doesn't mean touching every setter.
function snapshot(s: IntegrationsState): ConfigSlice {
  return {
    twitch: s.twitch,
    nas: s.nas,
    ytdlpPath: s.ytdlpPath,
    ffmpegPath: s.ffmpegPath,
    pexelsApiKey: s.pexelsApiKey,
    freesoundApiKey: s.freesoundApiKey,
    jamendoApiKey: s.jamendoApiKey,
    recentProjects: s.recentProjects,
  };
}

export const useIntegrations = create<IntegrationsState>((set, get) => ({
  twitch: null,
  nas: [],
  ytdlpPath: null,
  ffmpegPath: null,
  pexelsApiKey: null,
  freesoundApiKey: null,
  jamendoApiKey: null,
  recentProjects: [],
  loaded: false,

  load: async () => {
    const cfg = await loadConfig();
    set({
      twitch: cfg.twitch ?? null,
      nas: cfg.nasConnections ?? [],
      ytdlpPath: cfg.ytdlpPath ?? null,
      ffmpegPath: cfg.ffmpegPath ?? null,
      pexelsApiKey: cfg.pexelsApiKey ?? null,
      freesoundApiKey: cfg.freesoundApiKey ?? null,
      jamendoApiKey: cfg.jamendoApiKey ?? null,
      recentProjects: cfg.recentProjects ?? [],
      loaded: true,
    });
  },

  setTwitch: async (twitch) => {
    set({ twitch });
    await saveConfig(toConfig({ ...snapshot(get()), twitch }));
  },

  upsertNas: async (conn) => {
    const existing = get().nas.findIndex((c) => c.id === conn.id);
    const next =
      existing >= 0
        ? get().nas.map((c) => (c.id === conn.id ? conn : c))
        : [...get().nas, conn];
    set({ nas: next });
    await saveConfig(toConfig({ ...snapshot(get()), nas: next }));
  },

  removeNas: async (id) => {
    const next = get().nas.filter((c) => c.id !== id);
    set({ nas: next });
    await saveConfig(toConfig({ ...snapshot(get()), nas: next }));
  },

  setYtdlpPath: async (path) => {
    set({ ytdlpPath: path });
    await saveConfig(toConfig({ ...snapshot(get()), ytdlpPath: path }));
  },

  setPexelsApiKey: async (key) => {
    set({ pexelsApiKey: key });
    await saveConfig(toConfig({ ...snapshot(get()), pexelsApiKey: key }));
  },

  setFreesoundApiKey: async (key) => {
    set({ freesoundApiKey: key });
    await saveConfig(toConfig({ ...snapshot(get()), freesoundApiKey: key }));
  },

  setJamendoApiKey: async (key) => {
    set({ jamendoApiKey: key });
    await saveConfig(toConfig({ ...snapshot(get()), jamendoApiKey: key }));
  },

  setFfmpegPath: async (path) => {
    set({ ffmpegPath: path });
    await saveConfig(toConfig({ ...snapshot(get()), ffmpegPath: path }));
  },

  pushRecentProject: async (path) => {
    const cur = get().recentProjects;
    const next = [path, ...cur.filter((p) => p !== path)].slice(0, RECENT_PROJECTS_MAX);
    set({ recentProjects: next });
    await saveConfig(toConfig({ ...snapshot(get()), recentProjects: next }));
  },

  clearRecentProjects: async () => {
    set({ recentProjects: [] });
    await saveConfig(toConfig({ ...snapshot(get()), recentProjects: [] }));
  },
}));

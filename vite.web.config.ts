import { defineConfig, mergeConfig } from "vite";
import base from "./vite.config";

// Build config for the browser-hosted "web copy" of the editor (the desktop
// Tauri build keeps using vite.config.ts untouched, so its native performance is
// unaffected). Differences from the desktop build:
//
//   - base "/editor/": the marketing site serves the editor under that path, so
//     all asset URLs must be prefixed. nginx maps /editor/ -> this build.
//   - outDir "dist-web": kept separate from Tauri's dist/ so the two builds
//     never clobber each other.
//
// Build with:  npm run build:web   ->  dist-web/
export default mergeConfig(
  base,
  defineConfig({
    base: "/editor/",
    build: {
      outDir: "dist-web",
      emptyOutDir: true,
    },
  }),
);

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
// Tauri-aware Vite config. Tauri injects TAURI_DEV_HOST when targeting
// mobile / remote dev; for desktop the defaults are fine.
var host = process.env.TAURI_DEV_HOST;
export default defineConfig({
    plugins: [react()],
    resolve: {
        alias: {
            "@": path.resolve(__dirname, "src"),
        },
    },
    // Prevent Vite from obscuring Rust errors in the terminal
    clearScreen: false,
    server: {
        port: 5173,
        strictPort: true,
        host: host || false,
        hmr: host
            ? { protocol: "ws", host: host, port: 5174 }
            : undefined,
        watch: {
            // Don't watch the Rust side
            ignored: ["**/src-tauri/**"],
        },
    },
});

import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";

export default defineConfig({
  base: "./",
  plugins: [solid()],
  envPrefix: ["VITE_", "TAURI_"],
  test: {
    setupFiles: ["./__tests__/setup/vitest.setup.ts"],
  },
  server: {
    strictPort: true,
    port: 1420,
  },
  build: {
    outDir: ".output/public",
    emptyOutDir: true,
    assetsDir: "_build/assets",
    manifest: "_build/.vite/manifest.json",
  },
});

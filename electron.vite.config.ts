import { resolve } from "path";
import { defineConfig } from "electron-vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const rendererPort = Number(process.env.HERMES_DESKTOP_RENDERER_PORT || 0);

export default defineConfig({
  main: {
    build: {
      // The isolated Windows archive-validation helper is copied outside
      // app.asar. Bundle its pure-JS ZIP parser and its tiny transitive
      // dependency so ELECTRON_RUN_AS_NODE can resolve it there.
      externalizeDeps: { exclude: ["yauzl", "pend"] },
      rollupOptions: {
        external: ["better-sqlite3"],
        input: {
          index: resolve("src/main/index.ts"),
          "internal-beta-updater": resolve(
            "src/main/app/internal-beta-updater.ts",
          ),
          "runtime-inventory-helper": resolve(
            "src/main/runtime-inventory-helper.ts",
          ),
          "runtime-archive-validation-helper": resolve(
            "src/main/runtime-archive-validation-helper.ts",
          ),
        },
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          index: resolve("src/preload/index.ts"),
          askpass: resolve("src/preload/askpass.ts"),
        },
      },
    },
  },
  renderer: {
    ...(rendererPort > 0
      ? {
          server: {
            port: rendererPort,
            strictPort: false,
          },
        }
      : {}),
    resolve: {
      alias: {
        "@renderer": resolve("src/renderer/src"),
      },
      // Ensure a single Three.js instance across our code, @react-three/fiber,
      // drei and troika — multiple copies break `instanceof THREE.*` checks in
      // the ported office agent renderer.
      dedupe: ["three"],
    },
    plugins: [tailwindcss(), react()],
  },
});

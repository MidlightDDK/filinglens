import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Transformers.js points onnxruntime-web at its WASM on cdn.jsdelivr.net at
// runtime; the bundled fallback copy (~27 MB) is never fetched and exceeds the
// 25 MiB Workers static-asset limit, so drop it from the build.
const dropOrtWasm = (): Plugin => ({
  name: "drop-ort-wasm",
  generateBundle(_, bundle) {
    for (const name of Object.keys(bundle)) {
      if (/ort-wasm[^/]*\.wasm$/.test(name)) delete bundle[name];
    }
  },
});

export default defineConfig({
  plugins: [react(), tailwindcss(), dropOrtWasm()],
  // The search worker imports Transformers.js, which code-splits.
  worker: { format: "es", plugins: () => [dropOrtWasm()] },
  server: {
    // `pnpm dev` runs `wrangler dev` (worker/) on its default port alongside Vite.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});

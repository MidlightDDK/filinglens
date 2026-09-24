import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // `pnpm dev` runs `wrangler dev` (worker/) on its default port alongside Vite.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});

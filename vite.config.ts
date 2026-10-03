import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: { host: "127.0.0.1", port: 1420, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules") && /codemirror|@lezer|style-mod|w3c-keyname/.test(id)) return "editor";
          if (id.includes("node_modules") && /\/react(?:-dom)?\/|\/scheduler\//.test(id.replaceAll("\\", "/"))) return "react";
        },
      },
    },
  },
  test: { environment: "jsdom", globals: true, css: false },
});

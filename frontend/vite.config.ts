import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// the repo's VERSION file feeds the window / tab title ("Libretto 0.26.1108.0")
const version = readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim();

export default defineConfig({
  define: { __LB_VERSION__: JSON.stringify(version) },
  plugins: [react(), { name: "lb-title-version", transformIndexHtml: (html) => html.replace("<title>Libretto</title>", `<title>Libretto ${version}</title>`) }],
  test: { environment: "jsdom" },
  server: {
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:8000" },
  },
});

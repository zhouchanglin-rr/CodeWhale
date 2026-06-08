import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The runtime API server (`codewhale serve --mobile`) listens on 127.0.0.1:7878
// by default. In dev we proxy the API + SSE through Vite so the browser talks
// to the same origin and no CORS config is needed. Override the target with
// VITE_RUNTIME_TARGET when the runtime runs elsewhere.
const target = process.env.VITE_RUNTIME_TARGET ?? "http://127.0.0.1:7878";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5273,
    proxy: {
      "/v1": {
        target,
        changeOrigin: true,
        // Server-Sent Events: disable buffering so deltas stream through.
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            if (
              (proxyRes.headers["content-type"] ?? "").includes(
                "text/event-stream",
              )
            ) {
              proxyRes.headers["cache-control"] = "no-cache, no-transform";
            }
          });
        },
      },
      "/health": { target, changeOrigin: true },
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});

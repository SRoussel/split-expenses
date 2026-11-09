// The desktop page (split-insights). Separate from the phone app: it's built into
// dist-desktop/, which the Python server serves, and never deployed to Cloudflare.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://127.0.0.1:8765";

export default defineConfig({
  root: "desktop",
  publicDir: false,
  plugins: [react()],
  build: { outDir: "../dist-desktop", emptyOutDir: true },
  server: {
    // `npm run dev:desktop` while `uv run split-insights --no-open` runs on 8765.
    port: 5174,
    // The server only takes changes from its own origin, so present them as coming from there.
    proxy: {
      "/api": {
        target: API,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", API);
          });
        },
      },
    },
  },
});

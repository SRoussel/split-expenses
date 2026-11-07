import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const API = "http://localhost:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    // `npm run dev` runs the Worker (API + local D1) on 8787 and Vite on 5173.
    // The Worker refuses POSTs whose Origin doesn't match its own host (CSRF guard),
    // so the dev proxy presents requests as coming from the Worker's own origin.
    // This only affects local development; deployed, one Worker serves both.
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

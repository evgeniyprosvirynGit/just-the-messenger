import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteStaticCopy } from "vite-plugin-static-copy";

export default defineConfig({
  plugins: [
    react(),
    viteStaticCopy({
      targets: [
        {
          src: "node_modules/@cesium/engine/Build/**/*",
          dest: "cesium",
        },
      ],
    }),
  ],
  define: {
    CESIUM_BASE_URL: JSON.stringify("/cesium/"),
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://api:8080", changeOrigin: true },
      "/ws": { target: "ws://api:8080", ws: true },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("/node_modules/@cesium/")) {
            return "cesium-engine";
          }
          if (id.includes("/node_modules/react/") || id.includes("/node_modules/react-dom/")) {
            return "react-vendor";
          }
        },
      },
    },
  },
});

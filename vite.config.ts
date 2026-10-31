import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET || "http://127.0.0.1:4179",
        changeOrigin: false
      }
    }
  }
});

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const repoBase = "/hydraflow/";

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? repoBase : "/",
  plugins: [react()],
  server: {
    proxy: {
      "/api": "http://localhost:8787",
    },
  },
});

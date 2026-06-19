/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

const sharedSrc = fileURLToPath(
  new URL("../../packages/shared/src/index.ts", import.meta.url),
);

const SERVER_PORT = process.env.SERVER_PORT ?? "4317";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // 直接吃 shared 源码，避免 Vite 把它当 node_modules 依赖预打包
    alias: { "@agent-canvas/shared": sharedSrc },
  },
  server: {
    port: 5317,
    proxy: {
      "/api": { target: `http://localhost:${SERVER_PORT}`, changeOrigin: true },
      "/ws": { target: `ws://localhost:${SERVER_PORT}`, ws: true },
    },
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}"],
  },
});

import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    /**
     * Creature motion is defined entirely in `styles.css`, so the test that
     * asserts a creature moves as itself needs the real stylesheet in the
     * document rather than vitest's default empty stub.
     */
    css: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:3000",
    },
  },
});

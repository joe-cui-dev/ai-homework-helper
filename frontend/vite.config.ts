import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: "/",
  define: {
    global: "globalThis",
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setupTests.ts",
    css: true,
  },
});

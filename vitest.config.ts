import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["**/__tests__/**/*.test.ts", "**/*.test.ts"],
    exclude: ["node_modules", "dist", "client"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["server/**/*.ts"],
      exclude: ["server/**/__tests__/**", "server/index.ts"],
    },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "shared"),
    },
  },
});

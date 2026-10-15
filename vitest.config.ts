import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30000,
    // Cap workers: default = cores-1 oversubscribes a shared box when several
    // sessions test at once. 4 matches caddy-mcp/ctxlint/typed.
    maxWorkers: 4,
  },
});

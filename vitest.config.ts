import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Fixture roots live in the temp dir. Confinement itself is tested with an explicit allowedDirs.
    env: { TERRAFORM_CWD_MCP_ALLOWED_DIRS: tmpdir() },
    testTimeout: 30000,
    // Cap workers: default = cores-1 oversubscribes a shared box when several
    // sessions test at once. 4 matches caddy-mcp/ctxlint/typed.
    maxWorkers: 4,
  },
});

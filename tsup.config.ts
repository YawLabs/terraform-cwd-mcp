import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    target: "node20",
    banner: { js: "#!/usr/bin/env node" },
  },
  {
    entry: { server: "src/server.ts" },
    format: ["esm"],
    // Declarations come from `tsc -p tsconfig.build.json --emitDeclarationOnly`
    // in the build script, not from tsup: tsup 8.5's bundled rollup-plugin-dts is
    // built against TypeScript 5.x and crashes on TS 7 (same as caddy-mcp).
    dts: false,
    clean: false,
    target: "node20",
  },
]);

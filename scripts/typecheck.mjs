#!/usr/bin/env node
// Type-check the project, preferring oam's tsgo (`oam check .`, TypeScript 7
// native) and falling back to `tsc --noEmit`. Ported from caddy-mcp.
//
// Both read the SAME tsconfig.json and cover the same files, so this is a
// runtime choice, not a coverage one. This repo's devDependency is already
// TypeScript 7 (native tsc), so unlike caddy-mcp's original TS 5 measurement
// there is no large speed gap: on windows-arm64, 5 interleaved runs on a shared,
// noisy box, both landed between ~0.8 s and ~6 s with outliers on each side.
// The preference is kept for parity with the other @yawlabs servers and to
// dogfood oam; `oam check --no-daemon .` forces a one-shot check if the
// per-project daemon ever misbehaves, and TERRAFORM_CWD_MCP_RUNTIME=node (or
// `npm run typecheck:tsc`) pins tsc.
//
// The Node path resolves typescript's own entry and runs it under
// process.execPath rather than shelling out to npx. On Windows, spawning
// `npx.cmd` without `shell: true` fails EINVAL (Node's CVE-2024-27980
// mitigation), and enabling the shell would reintroduce quoting hazards --
// resolving the module is both safer and one process cheaper.
//
// Exit code is forwarded verbatim so release.sh's `npm run typecheck || fail`
// still gates correctly on either path.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describeRuntime, findOam } from "./runtime.mjs";

const require_ = createRequire(import.meta.url);

/**
 * Locate typescript's `tsc` entry via its package.json `bin` field.
 *
 * NOT `require.resolve('typescript/bin/tsc')`: TypeScript 7 ships an `exports`
 * map that does not list `./bin/tsc`, so deep-subpath resolution throws
 * ERR_PACKAGE_PATH_NOT_EXPORTED. The package.json IS exported.
 */
function resolveTscEntry() {
  const pkgJsonPath = require_.resolve("typescript/package.json");
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf-8"));
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.tsc;
  if (!rel) throw new Error("typescript package.json has no bin.tsc entry");
  return join(dirname(pkgJsonPath), rel);
}

function runTsc() {
  let tscPath;
  try {
    tscPath = resolveTscEntry();
  } catch (err) {
    console.error(`typecheck: could not locate tsc (${err.message}) -- run \`npm install\` first.`);
    return 1;
  }
  const res = spawnSync(process.execPath, [tscPath, "--noEmit"], { stdio: "inherit" });
  if (res.error) {
    console.error(`typecheck: could not run tsc: ${res.error.message}`);
    return 1;
  }
  return res.status ?? 1;
}

const oam = findOam();
console.log(describeRuntime(oam));

if (!oam) {
  process.exit(runTsc());
}

const res = spawnSync(oam.cmd, ["check", "."], { stdio: "inherit" });

// A runtime that resolved but then failed to spawn (deleted mid-run, EACCES)
// must not read as a clean type-check -- fall back rather than exit 0.
if (res.error) {
  console.error(`typecheck: ${oam.cmd} failed to spawn (${res.error.message}) -- falling back to tsc`);
  process.exit(runTsc());
}
process.exit(res.status ?? 1);

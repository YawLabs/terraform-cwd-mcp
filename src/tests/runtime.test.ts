import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Tests for scripts/runtime.mjs, whose only caller is scripts/typecheck.mjs
 * (`npm run typecheck`). Two properties matter to callers and are easy to drift
 * from the launcher, which reads the same variables and probes the same
 * binaries.
 *
 * Like launcher.test.ts, runtime.mjs is exercised as a SUBPROCESS rather than
 * imported: it is a .mjs outside src/, so importing it from a .ts test fails
 * `tsc` (no declaration file, and it is outside rootDir). Spawning also keeps
 * the env mutation inside the child.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RUNTIME = join(REPO_ROOT, "scripts", "runtime.mjs");

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
});

/** Run a probe script that imports the REAL scripts/runtime.mjs and prints one JSON line. */
function probe(body: string, nodeArgs: string[] = []): unknown {
  const dir = mkTemp("tfcwd-runtime-probe-");
  const file = join(dir, "probe.mjs");
  const importLine = `import { describeRuntime, findOam, isBuildTreeBinary } from ${JSON.stringify(`file://${RUNTIME.replace(/\\/g, "/")}`)};`;
  writeFileSync(file, `${importLine}\n${body}`);
  const res = spawnSync(process.execPath, [...nodeArgs, file], {
    encoding: "utf-8",
    env: { ...process.env },
    timeout: 60_000,
  });
  const line = (res.stdout ?? "").trim().split("\n").filter(Boolean).at(-1) ?? "";
  try {
    return JSON.parse(line);
  } catch {
    return undefined;
  }
}

describe("scripts/runtime.mjs isBuildTreeBinary()", () => {
  it("flags cargo target/ paths and not installed ones", () => {
    const value = probe(`process.stdout.write(JSON.stringify([
  isBuildTreeBinary("/home/u/oam/target/release/oam"),
  isBuildTreeBinary("C:\\\\code\\\\oam\\\\target\\\\debug\\\\oam.exe"),
  isBuildTreeBinary("/home/u/.oam/bin/oam"),
]));`);
    expect(value).toEqual([true, true, false]);
  });
});

/**
 * describeRuntime() prints on EVERY `npm run typecheck`, and the build-tree
 * warning is the whole reason `fromBuildTree` exists: a timing taken from a
 * binary a concurrent `cargo build` replaces mid-run measures the build, not the
 * runtime. Losing that warning must not be silent.
 */
describe("scripts/runtime.mjs describeRuntime()", () => {
  it("names the Node fallback when no oam was found", () => {
    const value = probe(`process.stdout.write(JSON.stringify(describeRuntime(null)));`);
    expect(value).toMatch(/oam not found/);
    expect(value).toMatch(new RegExp(process.version.replace(/\./g, "\\.")));
  });

  it("warns loudly about a cargo target/ binary and points at an installed one", () => {
    const value = probe(`process.stdout.write(JSON.stringify(describeRuntime(
  { cmd: "/home/u/oam/target/release/oam", version: "oam 0.19.0", fromBuildTree: true },
)));`);
    expect(value).toMatch(/WARNING/);
    expect(value).toMatch(/concurrent cargo build/);
    expect(value).toMatch(/timing-sensitive/);
    // The escape hatch and the fix must both be discoverable from the line.
    expect(value).toMatch(/TERRAFORM_CWD_MCP_RUNTIME=node/);
    expect(value).toMatch(/\.oam\/bin/);
  });

  it("keeps a normal oam line clean of the build-tree warning", () => {
    const value = probe(`process.stdout.write(JSON.stringify(describeRuntime(
  { cmd: "/home/u/.oam/bin/oam", version: "oam 0.19.0", fromBuildTree: false },
)));`);
    expect(value).toMatch(/oam 0\.19\.0/);
    expect(value).not.toMatch(/WARNING/);
  });
});

/**
 * TERRAFORM_CWD_MCP_RUNTIME=node must skip discovery, case-insensitively,
 * exactly as the launcher reads it (`=NODE` forces Node there). An exact
 * compare would make `=NODE` silently run the typecheck on oam the launcher
 * would have refused.
 *
 * `OAM_BIN` is the Node running the test, and a `--import` preload (the same
 * trick as launcher.test.ts's poseAsOam) makes runtime.mjs's `--version` probe
 * of it answer "oam 0.19.0": a runnable binary that identifies as oam, on every
 * platform, so `null` under RUNTIME=node is evidence the early return fired
 * rather than that nothing was found.
 */
const POSE_AS_OAM = [
  "--import",
  `data:text/javascript,${encodeURIComponent(
    [
      'import poseCp from "node:child_process";',
      'import { syncBuiltinESMExports as poseSync } from "node:module";',
      "const poseReal = poseCp.execFileSync;",
      "poseCp.execFileSync = function (cmd, args, opts) {",
      `  if (cmd === ${JSON.stringify(process.execPath)} && args?.[0] === "--version") return "oam 0.19.0\\n";`,
      "  return poseReal.call(this, cmd, args, opts);",
      "};",
      "poseSync();",
    ].join("\n"),
  )}`,
];

/** Isolation: OAM_BIN is the only discoverable candidate. */
const probeWith = (runtime: string, nodeArgs: string[] = POSE_AS_OAM) =>
  probe(
    `process.env.OAM_BIN = ${JSON.stringify(process.execPath)};
process.env.TERRAFORM_CWD_MCP_RUNTIME = ${JSON.stringify(runtime)};
process.env.HOME = ${JSON.stringify(mkTemp("tfcwd-rt-home-"))};
process.env.USERPROFILE = process.env.HOME;
process.env.LOCALAPPDATA = process.env.HOME;
process.env.PATH = process.env.HOME;
process.stdout.write(JSON.stringify(findOam()));`,
    nodeArgs,
  );

describe("scripts/runtime.mjs: RUNTIME=node skips discovery", () => {
  it("finds the OAM_BIN that answers with oam's banner when no runtime is forced (guards the case below)", () => {
    // Without this control, the assertion below could pass because OAM_BIN was
    // never accepted, not because discovery was skipped.
    expect(probeWith("")).toEqual({ cmd: process.execPath, version: "oam 0.19.0", fromBuildTree: false });
  });

  it("returns null without probing when the value is a non-lowercase 'node'", () => {
    expect(probeWith("NODE")).toBeNull();
  });
});

/**
 * Answering `--version` is not enough: node prints "v22.x.y", and accepting it
 * would make `npm run typecheck` run `node check .` and fail instead of falling
 * back to tsc. findOam requires oam's banner, as the launcher's oamBanner does.
 */
describe("scripts/runtime.mjs: a non-oam OAM_BIN", () => {
  it("skips a binary that runs but does not identify as oam", () => {
    // The real node, unposed, as the only candidate.
    expect(probeWith("", [])).toBeNull();
  });
});

/**
 * A wedged oam on PATH must not hang `npm run typecheck`: the probe is bounded
 * like the launcher's. Extracted from the real source (as launcher.test.ts does
 * for runtimePlan) rather than timed with a sleeping binary -- a shell-sleep
 * fixture is POSIX-only and would not run on Windows, and a fake that cannot be
 * spawned returns null without ever exercising the bound.
 */
describe("scripts/runtime.mjs: the oam probe is bounded", () => {
  const SOURCE = readFileSync(RUNTIME, "utf-8");

  it("passes a timeout to the oam --version probe", () => {
    const probeFn = SOURCE.match(/function findOam\(\) \{[\s\S]*?\n\}/)?.[0];
    expect(probeFn, "could not extract findOam() from scripts/runtime.mjs").toBeDefined();
    // The execFileSync call that probes a candidate must carry a timeout, or a
    // wedged binary blocks the typecheck forever.
    const call = probeFn!.match(/execFileSync\([\s\S]*?\);/)?.[0];
    expect(call, "findOam has no execFileSync call").toBeDefined();
    expect(call).toMatch(/timeout:\s*VERSION_PROBE_TIMEOUT_MS/);
  });

  it("defines that bound as a positive number of milliseconds", () => {
    const m = SOURCE.match(/const VERSION_PROBE_TIMEOUT_MS = ([\d_]+);/);
    expect(m, "VERSION_PROBE_TIMEOUT_MS is not defined").not.toBeNull();
    expect(Number(m![1]!.replace(/_/g, ""))).toBeGreaterThan(0);
    expect(Number(m![1]!.replace(/_/g, ""))).toBeLessThanOrEqual(60_000);
  });
});

/**
 * `npm run typecheck` is a RELEASE GATE (`release.sh` runs it with `|| fail`).
 * scripts/typecheck.mjs prefers `oam check .` and falls back to `tsc --noEmit`.
 * Two things must hold or a broken tree ships unchecked: the Node fallback must
 * actually run tsc and forward its exit code, and an oam that cannot be run must
 * reach that fallback rather than exiting 0.
 *
 * Driven as a subprocess of the real script (the whole point is the process's
 * own exit code). tsc over this repo takes a while, so the timeout is generous.
 */
describe("scripts/typecheck.mjs", () => {
  const TYPECHECK = join(REPO_ROOT, "scripts", "typecheck.mjs");

  function runTypecheck(env: Record<string, string | undefined>) {
    return spawnSync(process.execPath, [TYPECHECK], {
      encoding: "utf-8",
      cwd: REPO_ROOT,
      env: { ...process.env, ...env },
      timeout: 180_000,
    });
  }

  it("runs tsc and forwards its exit code under RUNTIME=node", () => {
    const res = runTypecheck({ TERRAFORM_CWD_MCP_RUNTIME: "node" });
    expect(res.stdout ?? "").toMatch(/runtime: node/);
    // A clean tree exits 0; what matters is that the code is tsc's, not a
    // hardcoded success (a hardcoded 0 would hide a real tsc failure).
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  }, 190_000);

  it("falls back to tsc when OAM_BIN names something that cannot run", () => {
    // An empty HOME/LOCALAPPDATA/PATH so a real oam on this machine cannot
    // answer: OAM_BIN (a directory -- passes existsSync, cannot be executed) is
    // then the only candidate, findOam rejects it, and the script must take the
    // Node path rather than a silent exit 0.
    const empty = mkTemp("tfcwd-typecheck-home-");
    const res = runTypecheck({
      TERRAFORM_CWD_MCP_RUNTIME: "auto",
      OAM_BIN: REPO_ROOT,
      HOME: empty,
      USERPROFILE: empty,
      LOCALAPPDATA: empty,
      PATH: dirname(process.execPath),
    });
    expect(res.stdout ?? "").toMatch(/runtime: node/);
    expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  }, 190_000);

  it("routes a resolved-but-unspawnable oam into tsc, never exit 0", () => {
    // Source-level. The probe and the spawn are separate calls, so a binary
    // deleted in between is a real window; there is no portable fixture for it,
    // so this pins the branch that handles it. Anchored on the oam.cmd message
    // so it does not match runTsc's own `if (res.error)` above it.
    const src = readFileSync(TYPECHECK, "utf-8");
    const branch = src.match(/if \(res\.error\) \{\n {2}console\.error\(`typecheck: \$\{oam\.cmd\}[\s\S]*?\n\}/)?.[0];
    expect(branch, "the oam spawn-failure branch is gone from scripts/typecheck.mjs").toBeDefined();
    expect(branch).toMatch(/process\.exit\(runTsc\(\)\)/);
    expect(branch).not.toMatch(/process\.exit\(0\)/);
  });
});

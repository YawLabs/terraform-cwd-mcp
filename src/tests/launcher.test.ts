import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Tests for bin/terraform-cwd-mcp.mjs -- the published `terraform-cwd-mcp`
 * entry point. Ported from caddy-mcp's src/tests/launcher.test.ts without its
 * sandbox cases (this launcher has no `--permission` sandbox), plus ssh-mcp's
 * stripPermissionFlags, Windows-shim and source-hygiene cases, and a gated
 * block that drives a real oam when one at the floor is installed.
 *
 * Every install runs this file, and a break here means "the server does not
 * start" for everyone.
 *
 * `OAM_BIN` is the seam that makes this testable without installing oam: the
 * launcher uses the override, before any discovery, once it answers
 * `--version` at or above the floor, so a stand-in can play the runtime.
 */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LAUNCHER = join(REPO_ROOT, "bin", "terraform-cwd-mcp.mjs");
const DIST_CLI = join(REPO_ROOT, "dist", "index.js");
const MISSING_OAM = join(REPO_ROOT, "does-not-exist-oam-binary");
const MODROOT = join(REPO_ROOT, "src", "tests", "fixtures", "modroot");

const isWin = process.platform === "win32";

const tempDirs: string[] = [];
function mkTemp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tempDirs) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
});

interface RunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/**
 * Run the launcher to completion. `onStderr` can fire a signal once the child
 * announces itself -- signalling before the child is up would test the wrong
 * thing.
 *
 * An `undefined` value REMOVES a variable. The child's env starts from
 * process.env, and Node's spawn skips keys whose value is undefined, so this is
 * how a case asserts "genuinely unset" instead of inheriting whatever the
 * machine running the suite happens to export.
 *
 * An override replaces the inherited key whatever its case. Windows env names
 * are case-insensitive but a spread of process.env keeps their spelling
 * (`Path`), so a plain `{ ...process.env, PATH }` would hand the child BOTH
 * keys and leave which one wins to the platform.
 *
 * `nodeArgs` go to the Node running the launcher, BEFORE the launcher path --
 * the slot a `--import` preload has to occupy.
 */
function runLauncher(
  args: string[],
  env: Record<string, string | undefined>,
  onStderr?: (chunk: string, child: ReturnType<typeof spawn>) => void,
  nodeArgs: string[] = [],
): Promise<RunResult> {
  const merged: Record<string, string | undefined> = { ...process.env };
  for (const key of Object.keys(env)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
  }
  Object.assign(merged, env);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [...nodeArgs, LAUNCHER, ...args], {
      env: merged,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr?.on("data", (d) => {
      const s = String(d);
      stderr += s;
      onStderr?.(s, child);
    });
    // "exit", not "close": a grandchild that outlives the child can hold an
    // inherited pipe open, so `close` might never fire. Drain briefly so
    // trailing output written just before exit is still captured.
    child.on("exit", (code, signal) => {
      const ms = Date.now() - started;
      setTimeout(() => resolve({ code, signal, stdout, stderr, ms }), 150);
    });
  });
}

/**
 * An environment with no oam anywhere discovery looks: HOME, USERPROFILE and
 * LOCALAPPDATA point at a fresh empty directory, so the installed locations are
 * empty, and PATH holds only the directory of the Node running this test. Keeps
 * a real oam on the developer's box out of reach -- discovery asks every binary
 * it can see, so an OAM_BIN that is passed over does not shield a case from
 * one. The launcher's own variables are cleared too; `extra` wins.
 */
function isolated(extra: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const empty = mkTemp("tfcwd-launcher-home-");
  return {
    PATH: dirname(process.execPath),
    HOME: empty,
    USERPROFILE: empty,
    LOCALAPPDATA: empty,
    OAM_BIN: undefined,
    OAM_INSTALL_DIR: undefined,
    TERRAFORM_CWD_MCP_RUNTIME: undefined,
    ...extra,
  };
}

const VERSION_LINE = /^terraform-cwd-mcp \d+\.\d+\.\d+/;

/** Connect an MCP client over stdio, list the tools and read one module through the WASM parser. */
async function mcpSmoke(command: string, args: string[], env: Record<string, string | undefined>) {
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env })) if (v !== undefined) merged[k] = v;
  for (const key of Object.keys(env)) {
    for (const existing of Object.keys(merged)) {
      if (existing.toLowerCase() === key.toLowerCase()) delete merged[existing];
    }
    const v = env[key];
    if (v !== undefined) merged[key] = v;
  }
  const transport = new StdioClientTransport({ command, args, env: merged, stderr: "pipe" });
  const client = new Client({ name: "launcher-smoke", version: "0.0.0" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const server = client.getServerVersion();
    const { tools } = await client.listTools();
    const res = await client.callTool({
      name: "tf_module_interface",
      arguments: { dir: MODROOT, module: "modules/naming" },
    });
    const text = (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
    return { server, tools: tools.map((t) => t.name), text, isError: res.isError === true };
  } finally {
    await client.close();
  }
}

// The launcher's node path imports dist/index.js, so it needs a build.
describe.skipIf(!existsSync(DIST_CLI))("launcher: runtime selection", () => {
  it("TERRAFORM_CWD_MCP_RUNTIME=node runs the server in-process and reports the version", async () => {
    const res = await runLauncher(["--version"], { TERRAFORM_CWD_MCP_RUNTIME: "node" });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
  }, 30000);

  it("auto with no oam anywhere falls back to Node silently", async () => {
    // The common case on a fresh machine: nothing was skipped, so there is
    // nothing to say.
    const res = await runLauncher(["--version"], isolated());
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).toBe("");
  }, 30000);

  it("reads TERRAFORM_CWD_MCP_RUNTIME case-insensitively", async () => {
    const res = await runLauncher(["--version"], isolated({ TERRAFORM_CWD_MCP_RUNTIME: "OAM", OAM_BIN: MISSING_OAM }));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no usable oam (0.19.0 or newer) was found");
  }, 30000);

  it("auto names an OAM_BIN that points at nothing, then falls back to Node", async () => {
    // A bad override must not be fatal in auto mode, or a stale OAM_BIN in a
    // host config would break every launch. It must not be SILENT either.
    const res = await runLauncher(["--version"], isolated({ TERRAFORM_CWD_MCP_RUNTIME: "auto", OAM_BIN: MISSING_OAM }));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).toMatch(/^terraform-cwd-mcp: OAM_BIN=.*does not exist; using Node instead\.$/m);
  }, 30000);

  it("TERRAFORM_CWD_MCP_RUNTIME=oam fails loudly when no oam binary exists", async () => {
    // Explicitly demanding oam is a real misconfiguration, so it must exit
    // non-zero rather than quietly running a different runtime.
    const res = await runLauncher(["--version"], isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam", OAM_BIN: MISSING_OAM }));
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no usable oam (0.19.0 or newer) was found");
    expect(res.stderr).toContain("does not exist");
    // The remedy names the cause that was seen: a wrong OAM_BIN, not an install.
    expect(res.stderr).toContain("Point OAM_BIN at an existing oam binary, or unset it.");
    expect(res.stderr).not.toContain("self-update");
    // Written synchronously before process.exit; an async write would be truncated.
    expect(res.stderr).toContain("TERRAFORM_CWD_MCP_RUNTIME=node");
  }, 30000);

  it("suggests installing oam when none exists anywhere (the first-run message)", async () => {
    // `isolated()` finds no oam at all and no OAM_BIN was given: the most common
    // first-run state, and the one whose remedy differs from every case above
    // (there is nothing to update, nothing wrong to unset -- oam is simply not
    // installed). Under `=oam` that is a hard failure, so the line prints.
    const res = await runLauncher(["--version"], isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam" }));
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("no usable oam (0.19.0 or newer) was found");
    // The remedy must be the install line, not self-update or an OAM_BIN hint.
    expect(res.stderr).toMatch(/Install oam from https:\/\/oamjs\.org, or set OAM_BIN/);
    expect(res.stderr).not.toContain("self-update");
    expect(res.stderr).not.toContain("Point OAM_BIN");
  }, 30000);

  it("speaks MCP over stdio through the launcher with no oam present", async () => {
    // The assertion the version cases cannot make: the published entry point
    // yields a working MCP server -- handshake, the nine tools, and a tool that
    // loads the vendored WASM grammar relative to dist/.
    const r = await mcpSmoke(process.execPath, [LAUNCHER], isolated());
    expect(r.server?.name).toBe("terraform-cwd-mcp");
    expect(r.tools).toHaveLength(9);
    expect(r.tools).toContain("tf_module_interface");
    expect(r.isError, r.text).toBe(false);
    expect(r.text).toMatch(/5 variables, 2 outputs/);
  }, 30000);
});

/**
 * Every in-process fallback must report a broken install with THIS launcher's
 * diagnostic, not a raw Node stack trace from the bare import(). The
 * `discover` branch covers it for `fallBackToNode`; the top-level
 * `plan === "in-process"` branch reaches `runInProcess()` directly and needs
 * the same guard.
 *
 * Reproduced on a copy of the launcher with no dist/ beside it (its
 * `../dist/index.js` import cannot resolve), under RUNTIME=node on a Node host,
 * which is exactly the in-process branch.
 */
describe("launcher: a broken install on the in-process path", () => {
  it("names the failure instead of dumping a Node module-resolution stack", async () => {
    const bin = mkTemp("tfcwd-in-process-bin-");
    const launcher = join(bin, "terraform-cwd-mcp.mjs");
    writeFileSync(launcher, readFileSync(LAUNCHER));
    // No dist/ next to it: the in-process import must fail.
    const res = await new Promise<RunResult>((resolve) => {
      const child = spawn(process.execPath, [launcher, "--version"], {
        env: { ...process.env, TERRAFORM_CWD_MCP_RUNTIME: "node" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += String(d)));
      child.stderr?.on("data", (d) => (stderr += String(d)));
      child.on("exit", (code, signal) => setTimeout(() => resolve({ code, signal, stdout, stderr, ms: 0 }), 150));
    });
    expect(res.stderr).toMatch(/^terraform-cwd-mcp: fallback to Node failed/m);
    expect(res.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    expect(res.stderr).not.toContain("node:internal");
    // The diagnostic must also fail the process: a host or script that keys on
    // the exit status must not read a server that never started as success.
    expect(res.code, "a failed server start must exit non-zero").toBe(1);
  }, 30000);
});

type Plan = "in-process" | "discover" | "handoff-node";
type RuntimePlan = (ctx: { mode: string; hostOam: string | undefined }) => Plan;
type Candidate = { path: string; version: number[] | null };
type PickNewest = (candidates: Candidate[]) => Candidate | null;

/** Pull named declarations out of the launcher source, loudly. */
function extract(patterns: RegExp[]): string {
  const source = readFileSync(LAUNCHER, "utf-8");
  return patterns
    .map((pattern) => {
      const match = source.match(pattern);
      if (!match) {
        throw new Error(`could not extract ${pattern} from bin/terraform-cwd-mcp.mjs -- renamed or reformatted?`);
      }
      return match[0];
    })
    .join("\n");
}

const OAM_MIN_DECL = /const OAM_MIN = \[[^\]]*\];/;
const ATLEAST_DECL = /function atLeast\(v, min\) \{[\s\S]*?\n\}/;

/**
 * Evaluate the REAL `runtimePlan` source, together with the declarations it
 * closes over, without importing the launcher.
 *
 * Why not import it: the launcher's module body resolves a runtime at import
 * time and either spawns oam or imports the server, so importing it from a
 * test would launch a server. Extracting the text exercises the shipped logic
 * rather than a copy that can drift, and a failed extraction is a loud
 * assertion, not a silent skip.
 */
function loadRuntimePlan(): RuntimePlan {
  const pieces = extract([
    OAM_MIN_DECL,
    /function parseVersion\(text\) \{[\s\S]*?\n\}/,
    ATLEAST_DECL,
    /function runtimePlan\(\{ mode, hostOam \}\) \{[\s\S]*?\n\}/,
  ]);
  return new Function(`${pieces}\nreturn runtimePlan;`)() as RuntimePlan;
}

/** The REAL `pickNewest`, extracted the same way, with the floor it closes over. */
function loadPickNewest(): { pickNewest: PickNewest; floor: number[] } {
  const pieces = extract([OAM_MIN_DECL, ATLEAST_DECL, /function pickNewest\(candidates\) \{[\s\S]*?\n\}/]);
  return new Function(`${pieces}\nreturn { pickNewest, floor: OAM_MIN };`)() as {
    pickNewest: PickNewest;
    floor: number[];
  };
}

// Pure logic over the launcher's source text: no build needed, so no skipIf.
describe("launcher: runtimePlan()", () => {
  const runtimePlan = loadRuntimePlan();

  it("serves in-process when already hosted on an oam at or above the floor", () => {
    // A host that launches `oam run bin/terraform-cwd-mcp.mjs` must not get a
    // SECOND oam. `auto` and `oam` both take the shortcut -- `oam` demands oam,
    // and the host already is one.
    //
    // 0.19.0 pins the floor as inclusive, and 0.100.0 pins a numeric compare: it
    // sorts BEFORE 0.19.0 as a string.
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.19.0", "0.20.0", "0.100.0", "1.0.0", "0.20.0-dev"]) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe("in-process");
      }
    }
  });

  it("never serves in-process on a host oam below the floor", () => {
    for (const mode of ["auto", "oam"]) {
      for (const hostOam of ["0.18.0", "0.17.0", "0.15.2", "0.9.0", "0.8.2", "0.0.1"]) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("discovers on Node, where process.versions has no oam key", () => {
    // An unreadable value must not count as "new enough" either: that would
    // skip discovery on a host that never proved it is a supported oam.
    for (const mode of ["auto", "oam", "anything-else"]) {
      for (const hostOam of [undefined, "", "dev"]) {
        expect(runtimePlan({ mode, hostOam }), `mode=${mode} hostOam=${hostOam}`).toBe("discover");
      }
    }
  });

  it("runs TERRAFORM_CWD_MCP_RUNTIME=node on Node: in-process on a Node host, handed off from any oam host", () => {
    expect(runtimePlan({ mode: "node", hostOam: undefined })).toBe("in-process");
    for (const hostOam of ["0.8.2", "0.19.0", "1.0.0", "dev"]) {
      expect(runtimePlan({ mode: "node", hostOam }), `hostOam=${hostOam}`).toBe("handoff-node");
    }
  });
});

describe("launcher: pickNewest()", () => {
  const { pickNewest, floor } = loadPickNewest();
  const at = (path: string, version: number[] | null): Candidate => ({ path, version });

  it("pins the floor to the latest oam release", () => {
    expect(floor).toEqual([0, 19, 0]);
  });

  it("takes the newest usable oam, not the first one found", () => {
    // The bug in caddy-mcp: discovery stopped at the first binary that existed,
    // so an older copy in an earlier location hid a newer one later.
    const chosen = pickNewest([at("installed", [0, 19, 0]), at("path-a", [0, 20, 0]), at("path-b", [0, 19, 9])]);
    expect(chosen?.path).toBe("path-a");
  });

  it("compares numerically and keeps search order on a tie", () => {
    expect(pickNewest([at("a", [0, 20, 0]), at("b", [0, 100, 0])])?.path).toBe("b");
    expect(pickNewest([at("first", [0, 19, 0]), at("second", [0, 19, 0])])?.path).toBe("first");
  });

  it("skips binaries below the floor or with no readable version", () => {
    expect(pickNewest([at("old", [0, 18, 0]), at("broken", null), at("good", [0, 19, 0])])?.path).toBe("good");
    expect(pickNewest([at("old", [0, 18, 0]), at("broken", null)])).toBeNull();
    expect(pickNewest([])).toBeNull();
  });
});

describe("launcher: stripPermissionFlags()", () => {
  // Since 0.18.0 oam appends its --permission / --allow-* flags to every child's
  // NODE_OPTIONS, and Node exits 9 on some of them there ("--allow-net is not
  // allowed in NODE_OPTIONS"). This launcher has no sandbox, so a child gets an
  // env without them.
  const strip = new Function(
    `${extract([/const PERMISSION_FLAG = .*;/, /function stripPermissionFlags\(env\) \{[\s\S]*?\n\}/])}\nreturn stripPermissionFlags;`,
  )() as (env: Record<string, string | undefined>) => Record<string, string | undefined>;

  it("drops --permission and every --allow-* grant, keeping other flags in order", () => {
    const env = {
      NODE_OPTIONS:
        "--max-old-space-size=4096 --permission --allow-fs-read=* --allow-net --no-warnings --allow-child-process",
      OTHER: "x",
    };
    expect(strip(env)).toEqual({ NODE_OPTIONS: "--max-old-space-size=4096 --no-warnings", OTHER: "x" });
  });

  it("removes NODE_OPTIONS entirely when only permission flags were in it", () => {
    const out = strip({ NODE_OPTIONS: "--permission --allow-net=example.com:443", KEEP: "1" });
    expect(out).toEqual({ KEEP: "1" });
    expect("NODE_OPTIONS" in out).toBe(false);
  });

  it("handles a quoted grant value containing spaces", () => {
    expect(strip({ NODE_OPTIONS: '--allow-fs-read="C:\\Program Files\\x" --trace-warnings' })).toEqual({
      NODE_OPTIONS: "--trace-warnings",
    });
  });

  it("drops the older --experimental-permission spelling too", () => {
    expect(strip({ NODE_OPTIONS: "--experimental-permission --enable-source-maps" })).toEqual({
      NODE_OPTIONS: "--enable-source-maps",
    });
  });

  it("returns the same env object when there is nothing to strip", () => {
    const env = { NODE_OPTIONS: "--enable-source-maps" };
    expect(strip(env)).toBe(env);
    const bare = { PATH: "/bin" };
    expect(strip(bare)).toBe(bare);
  });

  it("does not mutate the env it was given", () => {
    const env = { NODE_OPTIONS: "--permission --no-warnings" };
    strip(env);
    expect(env.NODE_OPTIONS).toBe("--permission --no-warnings");
  });

  it("is applied only on an oam host", () => {
    const src = readFileSync(LAUNCHER, "utf8");
    expect(src).toContain("env: process.versions.oam !== undefined ? stripPermissionFlags(process.env) : process.env,");
  });
});

/**
 * Run the REAL bin under Node posing as oam, by preloading a
 * `process.versions.oam` key, or as plain Node when `hostOam` is undefined.
 *
 * The runtimePlan() cases above prove the decision; these prove the launcher
 * WIRES it -- that the call site actually reads `process.versions.oam`.
 *
 * OAM_BIN is pinned to the Node binary running this test, which makes the two
 * outcomes unmistakable without a real oam, and cross-platform. In-process,
 * `--version` reaches dist/index.js and prints `terraform-cwd-mcp <version>`
 * with exit 0. On the discovery path, OAM_BIN is that pinned Node, the
 * preload makes the launcher's `--version` probe of it read "oam 0.19.0"
 * (the real `node --version` has no oam banner and would be passed over, see
 * "launcher: a non-oam OAM_BIN"), and the launcher spawns
 * `node run <entry> -- --version` -- which has no `run` subcommand, prints no
 * version and exits non-zero. A usable OAM_BIN is taken before discovery runs,
 * so a real oam installed on the developer's box is never reached either.
 *
 * Every run also reports, at exit, what the LAUNCHER process's argv[1] ended up
 * as: runInProcess points it at dist/index.js, a handoff leaves it on the
 * launcher. That is the only way to tell "served in-process" from "handed off
 * to a child that printed the same version".
 *
 * `extraPreload` is appended to the preload module, for a case that has to
 * change something else inside the launcher process before it runs.
 */
function runOnHost(
  hostOam: string | undefined,
  extraEnv: Record<string, string | undefined> = {},
  extraPreload = "",
): Promise<RunResult> {
  const exitMarker = `import { writeSync } from "node:fs"; process.on("exit", () => { try { writeSync(2, "LAUNCHER_ARGV1=" + process.argv[1] + "\\n"); } catch {} });`;
  const posing =
    hostOam === undefined
      ? ""
      : `Object.defineProperty(process.versions, "oam", { value: ${JSON.stringify(hostOam)}, enumerable: true });`;
  // The probe answers like oam only for this Node; every other execFileSync is real.
  const probe = [
    'import poseCp from "node:child_process";',
    'import { syncBuiltinESMExports as poseSync } from "node:module";',
    "const poseReal = poseCp.execFileSync;",
    "poseCp.execFileSync = function (cmd, args, opts) {",
    `  if (cmd === ${JSON.stringify(process.execPath)} && args?.[0] === "--version") return "oam 0.19.0\\n";`,
    "  return poseReal.call(this, cmd, args, opts);",
    "};",
    "poseSync();",
  ].join("\n");
  const preload = [
    "--import",
    `data:text/javascript,${encodeURIComponent(`${exitMarker}${posing}\n${probe}\n${extraPreload}`)}`,
  ];
  return runLauncher(
    ["--version"],
    { OAM_BIN: process.execPath, TERRAFORM_CWD_MCP_RUNTIME: undefined, ...extraEnv },
    undefined,
    preload,
  );
}

const IN_PROCESS_MARKER = /LAUNCHER_ARGV1=.*dist[\\/]index\.js/;
const HANDED_OFF_MARKER = /LAUNCHER_ARGV1=.*terraform-cwd-mcp\.mjs/;
const servedVersion = (run: RunResult) => run.code === 0 && VERSION_LINE.test(run.stdout.trim());

describe.skipIf(!existsSync(DIST_CLI))("launcher: on an oam host", () => {
  // Each case boots one to three Node processes, which outruns the suite's 30s
  // default on a contended Windows box.
  const TIMEOUT_MS = 45000;

  it(
    "control: on plain Node the launcher still discovers and spawns",
    async () => {
      // Without this, the in-process cases below would also pass for a launcher
      // that ALWAYS runs in-process and never uses oam at all.
      const run = await runOnHost(undefined);
      expect(servedVersion(run), `expected a spawn, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
    },
    TIMEOUT_MS,
  );

  it(
    "serves in-process instead of spawning a nested oam",
    async () => {
      const envs: Record<string, string>[] = [{}, { TERRAFORM_CWD_MCP_RUNTIME: "oam" }];
      for (const extraEnv of envs) {
        const run = await runOnHost("0.19.0", extraEnv);
        expect(servedVersion(run), `${JSON.stringify(extraEnv)} -> ${JSON.stringify(run)}`).toBe(true);
        expect(run.stderr).toMatch(IN_PROCESS_MARKER);
      }
    },
    TIMEOUT_MS,
  );

  it(
    "still discovers when the host oam is below the floor",
    async () => {
      // 0.18.0: the release just below the floor.
      const run = await runOnHost("0.18.0");
      expect(servedVersion(run), `a below-floor host must not shortcut, got ${JSON.stringify(run)}`).toBe(false);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
      // A spawned child failing, not the launcher diagnosing: every launcher
      // message starts with `terraform-cwd-mcp: `.
      expect(run.stderr).not.toMatch(/^terraform-cwd-mcp: /m);
    },
    TIMEOUT_MS,
  );
});

/**
 * Nothing usable to spawn. The launcher must still serve -- on the right
 * runtime -- or refuse loudly, and never serve on an oam below the floor.
 */
describe.skipIf(!existsSync(DIST_CLI))("launcher: with no usable oam", () => {
  const TIMEOUT_MS = 45000;

  it(
    "hands a below-floor oam host off to Node rather than serving on it",
    async () => {
      const run = await runOnHost("0.9.0", isolated({ OAM_BIN: MISSING_OAM }));
      expect(servedVersion(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.19\.0, and no newer oam was found; running on .*node/,
      );
      // Served by the child, not in the launcher process.
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
    },
    TIMEOUT_MS,
  );

  it(
    "refuses to serve on a below-floor oam host when there is no Node either",
    async () => {
      const noNode = mkTemp("tfcwd-launcher-nopath-");
      const run = await runOnHost("0.9.0", isolated({ PATH: noNode, OAM_BIN: MISSING_OAM }));
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim(), "nothing may be served").toBe("");
      expect(run.stderr).toMatch(/no Node was found on PATH/);
      expect(run.stderr).toContain("oam self-update");
    },
    TIMEOUT_MS,
  );

  it(
    "names the right remedy when TERRAFORM_CWD_MCP_RUNTIME=node on a supported oam finds no Node",
    async () => {
      // Not an outdated oam -- Node was asked for outright, so self-update is
      // the wrong advice.
      const noNode = mkTemp("tfcwd-launcher-nopath-");
      const run = await runOnHost("0.19.0", isolated({ PATH: noNode, TERRAFORM_CWD_MCP_RUNTIME: "node" }));
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr).toContain("TERRAFORM_CWD_MCP_RUNTIME=node on oam 0.19.0");
      expect(run.stderr).toContain("Put Node on PATH, or unset TERRAFORM_CWD_MCP_RUNTIME");
      expect(run.stderr).not.toContain("self-update");
    },
    TIMEOUT_MS,
  );

  it(
    "strips oam's permission flags from NODE_OPTIONS before handing off to Node",
    async () => {
      // Set inside the launcher process (the preload), not in the env the test
      // spawns it with, because the Node running the LAUNCHER here would refuse
      // it the same way. --no-warnings is a Node flag and must survive.
      const run = await runOnHost(
        "0.19.0",
        isolated({ TERRAFORM_CWD_MCP_RUNTIME: "node", OAM_BIN: MISSING_OAM }),
        `process.env.NODE_OPTIONS = "--permission --allow-net=localhost:2019 --allow-fs-read=/tmp --no-warnings";`,
      );
      expect(servedVersion(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
      expect(run.stderr).not.toContain("is not allowed in NODE_OPTIONS");
    },
    TIMEOUT_MS,
  );

  it(
    "hands TERRAFORM_CWD_MCP_RUNTIME=node off to Node even on a supported oam host",
    async () => {
      const run = await runOnHost("0.19.0", isolated({ TERRAFORM_CWD_MCP_RUNTIME: "node" }));
      expect(servedVersion(run), JSON.stringify(run)).toBe(true);
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
    },
    TIMEOUT_MS,
  );
});

/**
 * An OAM_BIN that runs and prints a version but is not oam (here: the real
 * Node, `v22.x.y`). The probe needs oam's own banner, so it is passed over like
 * an unreadable one instead of clearing the floor and being spawned as
 * `<node> run dist/index.js`, which dies with MODULE_NOT_FOUND and no fallback.
 */
describe.skipIf(!existsSync(DIST_CLI))("launcher: a non-oam OAM_BIN", () => {
  it("auto passes it over, says so, and serves on Node", async () => {
    const res = await runLauncher(["--version"], isolated({ OAM_BIN: process.execPath }));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).toMatch(
      /^terraform-cwd-mcp: OAM_BIN=.* could not be run, or did not report a version this launcher understands; using Node instead\.$/m,
    );
    expect(res.stderr).not.toContain("MODULE_NOT_FOUND");
  }, 30000);

  it("TERRAFORM_CWD_MCP_RUNTIME=oam refuses it rather than spawning it", async () => {
    const res = await runLauncher(
      ["--version"],
      isolated({ OAM_BIN: process.execPath, TERRAFORM_CWD_MCP_RUNTIME: "oam" }),
    );
    expect(res.code).toBe(1);
    expect(res.stdout).toBe("");
    expect(res.stderr).toContain("no usable oam (0.19.0 or newer) was found");
    expect(res.stderr).toContain("Check that it is an executable oam binary for this platform.");
    expect(res.stderr).not.toContain("MODULE_NOT_FOUND");
  }, 30000);
});

/**
 * The chosen oam passed its `--version` probe and then could not be spawned
 * (deleted or replaced in between), on an oam host.
 *
 * An oam host pipes stdio and mirrors the child on 'close'. A failed spawn
 * emits 'error' and THEN 'close' with the negative errno, so a close handler
 * that does not wait for 'spawn' exits the launcher in the middle of the
 * fallback 'error' just started, and nothing serves.
 *
 * The preload makes the FIRST spawn target a path that does not exist; any
 * later spawn (the Node handoff) runs normally. Cross-platform: no bash fake.
 */
describe.skipIf(!existsSync(DIST_CLI))("launcher: failed spawn on an oam host", () => {
  const TIMEOUT_MS = 45000;
  const FAIL_FIRST_SPAWN = [
    'import childProcess from "node:child_process";',
    'import { syncBuiltinESMExports } from "node:module";',
    "const realSpawn = childProcess.spawn;",
    "let failed = false;",
    "childProcess.spawn = function (cmd, args, opts) {",
    "  if (failed) return realSpawn.call(this, cmd, args, opts);",
    "  failed = true;",
    '  return realSpawn.call(this, cmd + ".does-not-exist", args, opts);',
    "};",
    "syncBuiltinESMExports();",
  ].join("\n");

  it(
    "still hands a below-floor host off to Node",
    async () => {
      const run = await runOnHost("0.9.0", isolated({ OAM_BIN: process.execPath }), FAIL_FIRST_SPAWN);
      expect(servedVersion(run), `the Node fallback must still serve, got ${JSON.stringify(run)}`).toBe(true);
      expect(run.stderr).toMatch(/^terraform-cwd-mcp: failed to launch oam at .*; using Node instead\.$/m);
      expect(run.stderr).toMatch(
        /this process is oam 0\.9\.0, older than 0\.19\.0, and the newer oam would not start; running on /,
      );
      expect(run.stderr).toMatch(HANDED_OFF_MARKER);
    },
    TIMEOUT_MS,
  );

  it(
    "exits 1 under TERRAFORM_CWD_MCP_RUNTIME=oam instead of falling back",
    async () => {
      const run = await runOnHost(
        "0.9.0",
        isolated({ OAM_BIN: process.execPath, TERRAFORM_CWD_MCP_RUNTIME: "oam" }),
        FAIL_FIRST_SPAWN,
      );
      expect(run.code, JSON.stringify(run)).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toMatch(/^terraform-cwd-mcp: failed to launch oam at /m);
      expect(run.stderr).not.toMatch(/running on /);
    },
    TIMEOUT_MS,
  );
});

/**
 * Windows discovery: `.exe` only. Node cannot spawn a .cmd/.bat without
 * `shell: true`, so a shim on PATH is named, never probed.
 */
describe.skipIf(!isWin || !existsSync(DIST_CLI))("launcher: Windows PATH discovery", () => {
  function dirWith(name: string, body: string): string {
    const dir = mkTemp("tfcwd-launcher-pathdir-");
    writeFileSync(join(dir, name), body);
    return dir;
  }

  it("skips a .cmd shim on PATH but names it in oam mode", async () => {
    const shimDir = dirWith("oam.cmd", "@echo off\r\n");
    const env = isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam" });
    const res = await runLauncher(["--version"], { ...env, PATH: `${shimDir}${delimiter}${env.PATH}` });
    expect(res.code).toBe(1);
    expect(res.stderr).toMatch(/oam\.cmd, but Node cannot execute a \.cmd\/\.bat directly/);
  }, 30000);

  it("names the skipped shim in auto mode, then falls back", async () => {
    const shimDir = dirWith("oam.cmd", "@echo off\r\n");
    const env = isolated();
    const res = await runLauncher(["--version"], { ...env, PATH: `${shimDir}${delimiter}${env.PATH}` });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).toMatch(/oam\.cmd.*using Node instead\./);
  }, 30000);

  it("probes an .exe later on PATH and never treats an earlier .cmd shim as a candidate", async () => {
    const shimDir = dirWith("oam.cmd", "@echo off\r\n");
    const exeDir = dirWith("oam.exe", "");
    const env = isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam" });
    const res = await runLauncher(["--version"], {
      ...env,
      PATH: [shimDir, exeDir, env.PATH].join(delimiter),
    });
    expect(res.code).toBe(1);
    // The .exe is empty so it cannot run, but naming it as a probed candidate
    // proves discovery reached it past the shim that came first.
    expect(res.stderr).toContain(`${join(exeDir, "oam.exe")} could not be run`);
    expect(res.stderr).not.toMatch(/oam\.cmd could not be run/);
    expect(res.stderr).toContain("Check that it is an executable oam binary for this platform.");
  }, 30000);
});

/**
 * Answering `--version` is MANDATORY for any stand-in oam: the launcher
 * requires >= OAM_MIN before it spawns. Shared by the POSIX-gated blocks below.
 * The fakes are bash scripts, which is also why those blocks skip on Windows.
 */
const VERSION_PROBE = ['if [ "$1" = "--version" ]; then echo "oam 0.19.0"; exit 0; fi'];

/** Write an executable stand-in oam into `dir` (a fresh temp dir by default); returns its path. */
function writeFake(body: string, dir = mkTemp("tfcwd-fake-oam-")): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "oam");
  writeFileSync(file, body, "utf-8");
  chmodSync(file, 0o755);
  return file;
}

/**
 * Signal forwarding and escalation. POSIX only, deliberately: on Windows
 * `child.kill(sig)` ignores the name and calls TerminateProcess, so the
 * launcher forwards nothing there.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: signal handling", () => {
  const GRACEFUL = [
    "#!/bin/bash",
    ...VERSION_PROBE,
    'cleanup() { echo "CHILD: cleanup ran" >&2; exit 0; }',
    "trap cleanup TERM INT",
    'echo "CHILD: up" >&2',
    "while true; do sleep 0.05; done",
    "",
  ].join("\n");

  const WEDGED = [
    "#!/bin/bash",
    ...VERSION_PROBE,
    "trap '' TERM INT",
    'echo "CHILD: up" >&2',
    "while true; do sleep 0.05; done",
    "",
  ].join("\n");

  const TOO_OLD = ["#!/bin/bash", 'echo "oam 0.8.9"', "exit 0", ""].join("\n");

  it("rejects an oam older than the supported floor", async () => {
    const res = await runLauncher(
      ["--version"],
      isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam", OAM_BIN: writeFake(TOO_OLD) }),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("is oam 0.8.9, older than 0.19.0");
    expect(res.stderr).toContain("Run `oam self-update` to get oam 0.19.0 or newer.");
    expect(res.stderr).not.toContain("https://oamjs.org");
  }, 30000);

  /** Signal the launcher `count` times, starting once the child is up. */
  function runWithSignals(oam: string, count: number) {
    let fired = false;
    return runLauncher([], { OAM_BIN: oam, TERRAFORM_CWD_MCP_RUNTIME: "oam" }, (chunk, child) => {
      if (fired || !chunk.includes("CHILD: up")) return;
      fired = true;
      for (let i = 0; i < count; i++) {
        setTimeout(() => child.kill("SIGINT"), i * 120);
      }
    });
  }

  it("lets a graceful child run its own shutdown", async () => {
    const res = await runWithSignals(writeFake(GRACEFUL), 1);
    expect(res.stderr).toContain("CHILD: cleanup ran");
    expect(res.code).toBe(0);
    // Well BELOW ESCALATE_AFTER_MS (5s): the child's own exit ended this.
    expect(res.ms).toBeLessThan(3000);
  }, 30000);

  it("escalates on a wedged child instead of hanging forever", async () => {
    const res = await runWithSignals(writeFake(WEDGED), 1);
    expect(res.code).toBe(130); // 128 + SIGINT
    expect(res.ms).toBeGreaterThan(4000); // the full 5s grace window was honored
    expect(res.ms).toBeLessThan(12000);
  }, 30000);

  it("does not hard-kill a graceful child when signals repeat", async () => {
    const res = await runWithSignals(writeFake(GRACEFUL), 3);
    expect(res.stderr).toContain("CHILD: cleanup ran");
    expect(res.code).toBe(0);
  }, 30000);
});

/**
 * Discovery asks EVERY oam it can see and takes the newest usable one. HOME is
 * a temp dir holding a fake ~/.oam/bin/oam, and PATH puts a second fake first.
 * POSIX only: the fakes are bash scripts at the exact names discovery looks for.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: discovery", () => {
  /** A stand-in oam reporting `version` that, when run, names itself on stderr. */
  const fake = (version: string, label: string) =>
    [
      "#!/bin/bash",
      `if [ "$1" = "--version" ]; then echo "oam ${version}"; exit 0; fi`,
      `echo "CHILD: ${label}" >&2`,
      "exit 0",
      "",
    ].join("\n");

  function withInstalledAndPath(installed: string, onPath: string, extra: Record<string, string | undefined> = {}) {
    const env = isolated(extra);
    const home = env.HOME as string;
    writeFake(installed, join(home, ".oam", "bin"));
    const pathDir = mkTemp("tfcwd-fake-path-");
    writeFake(onPath, pathDir);
    return { ...env, PATH: `${pathDir}${delimiter}${env.PATH}` };
  }

  it("spawns the newest usable oam, not the first one found", async () => {
    const env = withInstalledAndPath(fake("0.19.0", "installed"), fake("0.20.0", "path"), {
      TERRAFORM_CWD_MCP_RUNTIME: "oam",
    });
    const res = await runLauncher([], env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: path");
    expect(res.stderr).not.toContain("CHILD: installed");
  }, 30000);

  it("finds an oam in OAM_INSTALL_DIR that is on neither PATH nor a default location", async () => {
    const installDir = mkTemp("tfcwd-install-dir-");
    writeFake(fake("0.19.0", "install-dir"), installDir);
    const res = await runLauncher([], isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam", OAM_INSTALL_DIR: installDir }));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: install-dir");
  }, 30000);

  it("keeps the installed copy on a tie", async () => {
    const env = withInstalledAndPath(fake("0.19.0", "installed"), fake("0.19.0", "path"), {
      TERRAFORM_CWD_MCP_RUNTIME: "oam",
    });
    const res = await runLauncher([], env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: installed");
    expect(res.stderr).not.toContain("CHILD: path");
  }, 30000);

  it("passes over a below-floor oam, installed or OAM_BIN, and says so", async () => {
    const env = withInstalledAndPath(fake("0.18.0", "installed"), fake("0.19.0", "path"), {
      OAM_BIN: writeFake(fake("0.8.9", "override")),
    });
    const res = await runLauncher([], env);
    expect(res.code, res.stderr).toBe(0);
    expect(res.stderr).toContain("CHILD: path");
    expect(res.stderr).not.toMatch(/CHILD: (installed|override)/);
    expect(res.stderr).toMatch(
      /^terraform-cwd-mcp: OAM_BIN=.* is oam 0\.8\.9, older than 0\.19\.0; using .*oam \(oam 0\.19\.0\)\.$/m,
    );
  }, 30000);
});

/**
 * The version gate's TWO causes, and the AUTO half of both: a null version is
 * not "old", and telling that user to `oam self-update` sends them after the one
 * cause it definitely is not. POSIX only: the fakes are bash scripts.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: version gate fallback", () => {
  const TOO_OLD = ["#!/bin/bash", 'echo "oam 0.8.9"', "exit 0", ""].join("\n");
  const UNREADABLE = ["#!/bin/bash", 'echo "not a version"', "exit 0", ""].join("\n");

  it("falls back to Node when the oam it was given is too old", async () => {
    const res = await runLauncher(["--version"], isolated({ OAM_BIN: writeFake(TOO_OLD) }));
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).toContain("0.8.9");
    expect(res.stderr).toContain("older than 0.19.0");
    expect(res.stderr).toContain("using Node instead");
  }, 30000);

  it("falls back to Node when oam does not report a readable version", async () => {
    const res = await runLauncher(
      ["--version"],
      isolated({ TERRAFORM_CWD_MCP_RUNTIME: "auto", OAM_BIN: writeFake(UNREADABLE) }),
    );
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).toContain("could not be run, or did not report a version");
    expect(res.stderr).not.toContain("older than");
    expect(res.stderr).toContain("using Node instead");
    expect(res.stderr).not.toContain("self-update");
  }, 30000);

  it("names the unreadable binary, not self-update, under TERRAFORM_CWD_MCP_RUNTIME=oam", async () => {
    const res = await runLauncher(
      ["--version"],
      isolated({ TERRAFORM_CWD_MCP_RUNTIME: "oam", OAM_BIN: writeFake(UNREADABLE) }),
    );
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("could not be run, or did not report a version this launcher understands");
    expect(res.stderr).toContain("Check that it is an executable oam binary for this platform.");
    expect(res.stderr).not.toContain("https://oamjs.org");
    expect(res.stderr).not.toContain("self-update");
  }, 30000);
});

/**
 * Spawn failure AFTER a passing version probe: the fake DELETES ITSELF during
 * the probe. POSIX only, like the blocks above.
 */
describe.skipIf(isWin || !existsSync(DIST_CLI))("launcher: spawn failure fallback", () => {
  const VANISHING = ["#!/bin/bash", 'rm -f "$0"', ...VERSION_PROBE, 'echo "CHILD: up" >&2', "exit 0", ""].join("\n");

  it("falls back to Node when a version-passing oam cannot be spawned", async () => {
    const res = await runLauncher(["--version"], {
      TERRAFORM_CWD_MCP_RUNTIME: "auto",
      OAM_BIN: writeFake(VANISHING),
    });
    expect(res.code, res.stderr).toBe(0);
    expect(res.stdout.trim()).toMatch(VERSION_LINE);
    expect(res.stderr).not.toContain("CHILD: up");
  }, 30000);

  it("fails loudly on an unspawnable oam under TERRAFORM_CWD_MCP_RUNTIME=oam", async () => {
    const res = await runLauncher(["--version"], {
      TERRAFORM_CWD_MCP_RUNTIME: "oam",
      OAM_BIN: writeFake(VANISHING),
    });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("failed to launch oam");
    expect(res.stdout).toBe("");
  }, 30000);
});

/**
 * A REAL oam, when one at the floor is installed: the stand-ins above prove the
 * launcher's wiring, these prove the server itself works on the runtime the
 * launcher prefers -- including the vendored WASM grammar loaded relative to
 * dist/. Skipped on a machine without oam, like the terraform integration
 * tests are without terraform. Checks OAM_BIN, then the installed locations.
 */
function findRealOam(): string | null {
  const floor = (readFileSync(LAUNCHER, "utf8").match(OAM_MIN_DECL)?.[0].match(/\d+/g) ?? []).map(Number);
  const exe = isWin ? "oam.exe" : "oam";
  const candidates = [
    process.env.OAM_BIN,
    ...(isWin ? [join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe)] : []),
    join(homedir(), ".oam", "bin", exe),
  ].filter((p): p is string => !!p);
  for (const cmd of candidates) {
    if (!existsSync(cmd)) continue;
    try {
      const out = execFileSync(cmd, ["--version"], { encoding: "utf8", timeout: 10_000, windowsHide: true });
      const v = (out.match(/^oam\s+(\d+)\.(\d+)\.(\d+)/m) ?? []).slice(1).map(Number);
      if (v.length !== 3) continue;
      const cmp = v[0] - floor[0] || v[1] - floor[1] || v[2] - floor[2];
      if (cmp >= 0) return cmd;
    } catch {
      // Not runnable here; try the next one.
    }
  }
  return null;
}
const REAL_OAM = findRealOam();

describe.skipIf(!REAL_OAM || !existsSync(DIST_CLI))("launcher: with a real oam at the floor", () => {
  const TIMEOUT_MS = 60000;

  it(
    "serves MCP through the launcher's oam path (TERRAFORM_CWD_MCP_RUNTIME=oam, OAM_BIN = the real oam)",
    async () => {
      // RUNTIME=oam, not auto: auto falls back to Node in-process on any oam
      // failure and prints the same answer, so this would pass with the oam
      // path broken. Under =oam a failed choice or spawn exits non-zero.
      const r = await mcpSmoke(process.execPath, [LAUNCHER], {
        OAM_BIN: REAL_OAM as string,
        TERRAFORM_CWD_MCP_RUNTIME: "oam",
      });
      expect(r.server?.name).toBe("terraform-cwd-mcp");
      expect(r.tools).toHaveLength(9);
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(/5 variables, 2 outputs/);
    },
    TIMEOUT_MS,
  );

  it(
    "serves MCP in-process when a host launches `oam run` on the launcher",
    async () => {
      const r = await mcpSmoke(REAL_OAM as string, ["run", LAUNCHER], {});
      expect(r.server?.name).toBe("terraform-cwd-mcp");
      expect(r.tools).toHaveLength(9);
      expect(r.isError, r.text).toBe(false);
      expect(r.text).toMatch(/5 variables, 2 outputs/);
    },
    TIMEOUT_MS,
  );

  it(
    "prints the version through the oam path with TERRAFORM_CWD_MCP_RUNTIME=oam",
    async () => {
      const res = await runLauncher(["--version"], { OAM_BIN: REAL_OAM as string, TERRAFORM_CWD_MCP_RUNTIME: "oam" });
      expect(res.code, res.stderr).toBe(0);
      expect(res.stdout.trim()).toMatch(VERSION_LINE);
    },
    TIMEOUT_MS,
  );
});

describe("launcher: source hygiene", () => {
  it("contains no literal control characters", () => {
    // A stray U+0008 once shipped in ssh-mcp's launcher: invisible in a terminal,
    // and it makes git treat the file as binary so the diff cannot be reviewed.
    const src = readFileSync(LAUNCHER, "utf8");
    const offenders: string[] = [];
    src.split("\n").forEach((line, i) => {
      for (const ch of line) {
        const code = ch.codePointAt(0) ?? 0;
        if (code < 32 && ch !== "\t" && ch !== "\r") {
          offenders.push(`line ${i + 1}: U+${code.toString(16).padStart(4, "0").toUpperCase()}`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it("bounds every `oam --version` probe with a timeout", () => {
    // oamVersion() probes ANY binary discovery can see, including OAM_BIN and a
    // stale entry on PATH. Without a bound, one wedged binary hangs the launch
    // with no way out -- and the failure is silent (no output, no exit). This is
    // the launcher's OWN probe, separate from scripts/runtime.mjs's.
    const src = readFileSync(LAUNCHER, "utf8");
    const fn = src.match(/function oamVersion\(cmd\) \{[\s\S]*?\n\}/)?.[0];
    expect(fn, "could not extract oamVersion() from bin/terraform-cwd-mcp.mjs").toBeDefined();
    expect(fn).toMatch(/timeout:\s*VERSION_PROBE_TIMEOUT_MS/);
    const decl = src.match(/const VERSION_PROBE_TIMEOUT_MS = ([\d_]+);/);
    expect(decl, "VERSION_PROBE_TIMEOUT_MS is not defined in the launcher").not.toBeNull();
    const ms = Number(decl![1]!.replace(/_/g, ""));
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(60_000);
  });
});

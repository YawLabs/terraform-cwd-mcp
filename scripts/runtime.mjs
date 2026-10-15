// oam discovery for the typecheck script.
//
// Ported from caddy-mcp's scripts/runtime.mjs. Differences: the escape-hatch
// variable (TERRAFORM_CWD_MCP_RUNTIME), and findOam has no `require` option --
// caddy's only caller of it builds an oam-compiled binary, which this repo does
// not ship (npm only), so the option would be dead code here.
//
// Policy: oam is the DEFAULT and Node is the FALLBACK. oam is a separate
// TypeScript runtime (https://oamjs.org) that is not an npm dependency, so it
// is never assumed present -- every caller must degrade to the Node path when
// `findOam()` returns null, and a contributor with only Node installed must
// still get a working typecheck and build.
//
// Discovery order:
//   1. $OAM_BIN                   -- explicit path wins (CI images, non-PATH installs)
//   2. the installed locations    -- ~/.oam/bin, %LOCALAPPDATA%\oam\bin
//   3. `oam` on PATH
//   4. null                       -- caller falls back to Node
//
// WHY INSTALLED LOCATIONS OUTRANK PATH
// A developer working on oam itself usually has `oam/target/release` on PATH,
// and a build directory's contents change underneath you: a concurrent
// `cargo build` replaces the binary mid-run, and freshly-written bytes are
// unscanned, uncached and cold. In caddy-mcp a benchmark taken against such a
// binary concluded `oam run` was slower than Node; against an installed oam it
// was faster. Prefer an installed copy so the binary is stable for the run.
//
// Escape hatch: TERRAFORM_CWD_MCP_RUNTIME=node forces the Node path even when
// oam is installed, so a regression can be bisected against the Node toolchain
// without uninstalling anything.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";

const isWin = process.platform === "win32";
const exeName = isWin ? "oam.exe" : "oam";

/** Bound on each `oam --version` probe, as in the launcher's discovery. */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

/**
 * The per-user locations oamjs.org's installers write to. Both forms are
 * checked on Windows: the installer defaults to %LOCALAPPDATA%\oam\bin there,
 * but oam's own docs name ~/.oam/bin first and OAM_INSTALL_DIR can put it
 * either place, so checking only one silently misses a real install.
 */
function installedCandidates() {
  const home = homedir();
  const paths = [join(home, ".oam", "bin", exeName)];
  if (isWin) {
    paths.unshift(join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "oam", "bin", exeName));
  }
  return paths;
}

/**
 * Absolute paths for `oam` on PATH, so callers see WHERE it came from.
 *
 * bin/terraform-cwd-mcp.mjs carries its OWN discovery, and the two are
 * deliberately not shared: this one walks the full PATHEXT on Windows, the
 * launcher's is restricted to `.exe`. Node cannot spawn a .cmd/.bat without
 * `shell: true`, and the launcher names a skipped shim on stderr, so its
 * discovery collects only what it can execute. Here the candidate is probed
 * with execFileSync before it is returned (see findOam below), so a shim that
 * cannot be run is dropped anyway and a wider walk only ever finds more. The
 * launcher also asks EVERY candidate for its version and takes the newest;
 * this returns the first that runs. Keep them separate.
 */
function pathCandidates() {
  const found = [];
  const exts = isWin ? (process.env.PATHEXT ?? ".EXE").split(";").filter(Boolean) : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of isWin ? exts : [""]) {
      const candidate = join(dir, isWin ? `oam${ext.toLowerCase()}` : "oam");
      if (existsSync(candidate)) found.push(candidate);
    }
  }
  return found;
}

/**
 * True when a path sits inside a Cargo build output directory.
 * Those are the binaries a concurrent cargo build replaces mid-run.
 */
export function isBuildTreeBinary(p) {
  const n = p.replaceAll(sep, "/").toLowerCase();
  return n.includes("/target/release/") || n.includes("/target/debug/");
}

/**
 * Resolve an oam executable, or null when oam should not be used.
 * Verifies the binary actually runs -- a stale $OAM_BIN or a broken PATH entry
 * must degrade to Node rather than fail the typecheck.
 *
 * Returns `{ cmd, version, fromBuildTree }`. `fromBuildTree` is true when the
 * only oam available lives under `target/`; callers doing anything
 * timing-sensitive should surface that rather than publish the number.
 */
export function findOam() {
  // Case-insensitive, matching the launcher's own read of the same variable
  // (`bin/terraform-cwd-mcp.mjs`): `=NODE` must force the Node path here too,
  // or the typecheck silently uses oam the launcher would have refused.
  if ((process.env.TERRAFORM_CWD_MCP_RUNTIME ?? "").toLowerCase() === "node") return null;

  const candidates = [];
  // An explicit OAM_BIN is an instruction, not a hint -- it is never reordered,
  // and a build-tree path given deliberately is still honoured (flagged, not
  // overridden).
  if (process.env.OAM_BIN) candidates.push(process.env.OAM_BIN);
  // Installed copies before PATH: see the note at the top of this file.
  candidates.push(...installedCandidates());
  candidates.push(...pathCandidates());

  for (const cmd of candidates) {
    if (!existsSync(cmd)) continue;
    try {
      const out = execFileSync(cmd, ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        // Bounded like the launcher's probe: a wedged oam on PATH must not hang
        // `npm run typecheck` with no way out.
        timeout: VERSION_PROBE_TIMEOUT_MS,
      });
      return { cmd, version: out.trim(), fromBuildTree: isBuildTreeBinary(cmd) };
    } catch {
      // Not executable, wrong arch, or a stale entry -- try the next candidate.
    }
  }

  return null;
}

/** One-line banner so script output always states which runtime produced it. */
export function describeRuntime(oam) {
  if (!oam) return `runtime: node ${process.version} (oam not found -- using the Node fallback)`;
  const warning = oam.fromBuildTree
    ? "\n  WARNING: this oam lives in a cargo target/ directory. Checks are fine, but do NOT" +
      "\n  take timings from it -- a concurrent cargo build replaces the binary mid-run and" +
      "\n  fresh bytes are cold, so the number measures the build, not the runtime." +
      "\n  Use an installed oam (~/.oam/bin) for anything timing-sensitive."
    : "";
  return `runtime: ${oam.version} (${oam.cmd}) -- set TERRAFORM_CWD_MCP_RUNTIME=node to force the Node path${warning}`;
}

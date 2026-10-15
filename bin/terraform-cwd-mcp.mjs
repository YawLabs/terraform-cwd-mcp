#!/usr/bin/env node
/**
 * Runtime launcher for @yawlabs/terraform-cwd-mcp.
 *
 * Prefers the newest usable oam runtime (https://oamjs.org) and falls back to
 * Node. It never serves on an oam older than the floor below.
 *
 * Ported from caddy-mcp's bin/caddy-mcp.mjs without its `--permission` sandbox
 * (see NO SANDBOX HERE); the no-sandbox shape -- runtimePlan without a sandbox
 * input, stripPermissionFlags, fallBackToNode -- follows ssh-mcp's launcher,
 * which made the same cut.
 *
 * This server is NOT a zero-dependency bundle: dist/ imports
 * @modelcontextprotocol/sdk, zod and web-tree-sitter from node_modules, and
 * src/hcl.ts reads the tree-sitter-hcl grammar from ../vendor relative to
 * dist/. That is fine on both paths: oam resolves npm packages against an
 * existing node_modules and gives import.meta.url its file:// URL, so the
 * grammar path resolves the same way it does on Node. Verified on oam 0.19.0
 * through this launcher: an MCP handshake, tools/list, tf_module_interface (the
 * WASM parser), tf_list_providers (a terraform spawn with a large stdout) and
 * tf_upgrade_impact (temp-dir init, junctions, two validates, cleanup).
 *
 * WHY THE FALLBACK COSTS NOTHING
 * npm has already started Node to run this launcher, so falling back is a
 * plain `import()` of the server into THIS process: no extra spawn, no extra
 * startup, byte-identical to invoking dist/index.js directly. Finding the
 * candidates is stat-only, so a machine without oam never pays for a
 * subprocess.
 *
 * WHAT THE OAM PATH COSTS
 * Reaching oam through an npm `bin` means Node boots first, every oam binary
 * found is asked for its version, and then oam boots to serve -- so the
 * launcher is slower than pointing a host at oam directly. It exists for `npx`
 * convenience. For an MCP host config, point straight at oam and skip this file:
 *   { "command": "oam", "args": ["run", "<abs>/dist/index.js"] }
 *
 * WHICH OAM
 * OAM_BIN, when set and usable, is used as given. Otherwise every oam binary
 * discovery can see -- OAM_INSTALL_DIR, the installed locations, then PATH --
 * is asked for its version, and the NEWEST one at or above the floor wins; a
 * tie keeps search order. Taking the first binary found instead let a stale
 * copy early in the search order hide a current one later: in caddy-mcp, with
 * oam 0.9.0 installed in ~/.oam/bin and 0.15.2 on PATH, the launcher bound to
 * 0.9.0 because installed locations are searched first.
 *
 * An OAM_BIN that does not exist, is below the floor, or will not run is always
 * named on stderr, and discovery carries on. The discovered binaries that were
 * passed over, and any .cmd/.bat shim on PATH, are named only when NO usable
 * oam is found.
 *
 * ALREADY RUNNING ON OAM
 * A host can resolve this package's `bin` and launch `oam run <this file>`
 * instead of `node <this file>` -- Yaw MCP does. Spawning a second oam there
 * would cost two runtime boots for one server, so when `process.versions.oam`
 * clears the floor, the server is imported into THIS process exactly as the
 * Node fallback is -- no discovery, no `oam --version` probe, no second oam.
 * OAM_BIN is a discovery input, so it is not consulted on that path: the host
 * has already chosen which oam runs.
 *
 * Nothing forces a re-spawn on a supported host: the spawn below passes oam no
 * runtime flags -- there is no `--permission` sandbox to apply, see NO SANDBOX
 * HERE -- so serving in-process drops nothing a fresh oam would have applied.
 *
 * A host oam BELOW the floor never serves. It hands the server off to the
 * newest usable oam, or to Node found on PATH, or exits with an error when
 * there is neither.
 *
 * That handoff PIPES stdio rather than inheriting it. Before 0.9.0 oam treated
 * `stdio: 'inherit'` as `'pipe'`, so an inherited handoff from such a host
 * connected the child to pipes nobody reads (measured on aws-mcp's launcher,
 * which this one descends from: the MCP handshake never answered). Piping the
 * streams explicitly completes it, to both oam and Node. A Node host keeps
 * `inherit`, which hands over the same fds untouched.
 *
 * NO SANDBOX HERE -- DELIBERATELY
 * caddy-mcp talks to one admin endpoint, so its `--permission` grants can be
 * narrow. This server cannot do that: every schema, plan and
 * state tool spawns `terraform` (which in turn executes the provider plugins in
 * the user's .terraform/), tools read whatever directory the caller names,
 * tf_upgrade_impact writes temp dirs, junctions and a plugin cache and its
 * `terraform init` reaches the registry, and the disk cache lives under the
 * user's home. Child-process, filesystem and (through terraform) network would
 * all have to be granted wide open, so nothing meaningful is left to deny and
 * `--permission` is not wired up.
 *
 * MINIMUM OAM VERSION
 * The latest oam release, 0.19.0 -- bump OAM_MIN when oam ships a newer one.
 * Only the current oam is used and verified; an older one is passed over.
 *
 * The floor is not cosmetic. The server runs terraform with an explicit child
 * `env` that DELETES variables -- TF_DATA_DIR from the state commands, and
 * TF_DATA_DIR plus TF_WORKSPACE from tf_upgrade_impact's temp-dir init and
 * validate (src/schema.ts terraformEnv, src/state.ts, src/upgrade.ts). Up to
 * 0.17.x oam laid an explicit `env` OVER its startup environment, so a deleted
 * variable came back (recorded in ssh-mcp's launcher, which needs the same
 * semantics for SSH_AUTH_SOCK); 0.18.0 made an explicit `env` replace it, as
 * Node does. A resurrected TF_DATA_DIR would point the state commands at a
 * different workspace than the one the read-only guard checked. Re-measured on
 * 0.19.0: a child spawned with TF_DATA_DIR deleted does not see it.
 *
 * SELECTION
 *   TERRAFORM_CWD_MCP_RUNTIME=auto   newest usable oam, else Node (default)
 *   TERRAFORM_CWD_MCP_RUNTIME=oam    newest usable oam, else exit with an error
 *                                    (already running on oam at the floor
 *                                    satisfies it)
 *   TERRAFORM_CWD_MCP_RUNTIME=node   Node: in THIS process on Node, handed off
 *                                    to Node on PATH when THIS process is oam
 *   OAM_BIN=/path/to/oam             use this oam when it is usable, before
 *                                    discovery
 * The value is case-insensitive; anything else behaves like `auto`.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { constants, homedir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Oldest oam this server runs on: the latest release, verified end to end. It
 * must stay at or above the one whose explicit child `env` replaces the
 * environment (needed by every terraform spawn that deletes TF_DATA_DIR). See
 * MINIMUM OAM VERSION above.
 */
const OAM_MIN = [0, 19, 0];

/**
 * Bound on each `oam --version` probe. A healthy oam answers in milliseconds;
 * the bound only exists so a wedged binary on PATH cannot hang the launch.
 */
const VERSION_PROBE_TIMEOUT_MS = 5_000;

// Two forms, deliberately. `import()` on Windows REJECTS a bare `C:\...` path
// with ERR_UNSUPPORTED_ESM_URL_SCHEME (it reads `c:` as a protocol), so the
// in-process fallback must use the file:// URL. spawn() needs a real path.
const SERVER_URL = new URL("../dist/index.js", import.meta.url);
const SERVER_ENTRY = fileURLToPath(SERVER_URL);
const isWin = process.platform === "win32";
const exe = isWin ? "oam.exe" : "oam";

/** Identity for de-duplicating paths: resolved, and case-folded on Windows. */
function pathKey(p) {
  let key = p;
  try {
    key = realpathSync(p);
  } catch {
    // Unresolvable: fall back to the literal path.
  }
  return isWin ? key.toLowerCase() : key;
}

/**
 * Every oam binary discovery can see, in search order, de-duplicated. Stat-only,
 * never a subprocess -- PATH is resolved manually rather than by spawning
 * `which`/`where`.
 *
 * Installed locations come BEFORE PATH, so when two binaries report the same
 * version the installed copy wins the tie. Someone who develops oam itself
 * usually has oam/target/release on PATH, and cargo replaces that binary
 * underneath running processes; the installed copy is the release the user
 * actually installed. Both forms are checked on Windows: the installer defaults
 * to %LOCALAPPDATA%\oam\bin there, but oam's docs name ~/.oam/bin first.
 * OAM_INSTALL_DIR, when set, is searched before both: it is the installer's
 * target, so an oam put somewhere custom and left off PATH is still found.
 *
 * Windows: `.exe` ONLY -- deliberately narrower than PATHEXT. Node refuses to
 * run a .cmd/.bat through execFile/spawn without `shell: true` (EINVAL, and for
 * spawn it throws SYNCHRONOUSLY rather than emitting 'error'), so walking the
 * full PATHEXT list would hand back a path this launcher cannot execute. A
 * skipped shim is still named on stderr when no usable oam is found -- see
 * findOamShim.
 *
 * scripts/runtime.mjs carries its OWN findOam that DOES walk the full PATHEXT.
 * That is a deliberate difference, not drift: it serves the typecheck
 * script, drops whatever fails its execFileSync probe, and has no
 * diagnostic to give. Same question, different constraint; change one and
 * re-read the other.
 */
function discoverOamPaths() {
  const installed = [join(homedir(), ".oam", "bin", exe)];
  if (isWin) {
    installed.unshift(join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "oam", "bin", exe));
  }
  if (process.env.OAM_INSTALL_DIR) installed.unshift(join(process.env.OAM_INSTALL_DIR, exe));
  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, exe));
  const seen = new Set();
  const found = [];
  for (const candidate of [...installed, ...onPath]) {
    if (!existsSync(candidate)) continue;
    const key = pathKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    found.push(candidate);
  }
  return found;
}

/**
 * Write a diagnostic to stderr synchronously, so a following process.exit
 * cannot truncate it.
 *
 * Not a bare writeSync: that call can short-write (it returns a byte count) and
 * on macOS it can throw EAGAIN, because Node makes a piped stderr non-blocking
 * there rather than blocking the write. Loop over the remaining bytes, and if
 * stderr turns out to be unusable give up quietly -- failing to print a
 * diagnostic is not worth crashing a stdio server over.
 */
async function errSync(message) {
  const { writeSync } = await import("node:fs");
  const buf = Buffer.from(message);
  let off = 0;
  for (let attempts = 0; off < buf.length && attempts < 1000; attempts++) {
    try {
      off += writeSync(2, buf, off, buf.length - off);
    } catch (err) {
      if (err?.code !== "EAGAIN") return;
      // Pipe is full and the reader has not drained yet -- retry.
    }
  }
}

/**
 * Version text -> [major, minor, patch], or null when it holds no version.
 * A pre-release suffix (0.9.0-rc.1) truncates to its base version.
 *
 * Shared by the two places a version is read -- a discovered binary's
 * `oam --version` banner ("oam 0.15.1", via oamBanner) and the host's own
 * `process.versions.oam` ("0.15.1") -- so they cannot disagree about what a
 * version string means, or which floor it has to clear.
 */
function parseVersion(text) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * `oam --version` output -> [major, minor, patch], or null unless it carries
 * oam's own banner ("oam 0.19.0" at the start of a line). Any x.y.z is NOT
 * enough: an OAM_BIN (or an oam.exe on disk) that is really another program --
 * node prints "v22.22.2" -- would clear the floor, and the launcher would then
 * spawn `<it> run dist/index.js`, which dies with no Node fallback because the
 * spawn itself succeeded. process.versions.oam needs no banner: only oam sets it.
 */
function oamBanner(text) {
  const m = /^oam\s+(\d+\.\d+\.\d+)/m.exec(text);
  return m ? parseVersion(m[1]) : null;
}

/** `oam --version` -> [major, minor, patch], or null when it cannot be read. */
function oamVersion(cmd) {
  try {
    const out = execFileSync(cmd, ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: VERSION_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    return oamBanner(out);
  } catch {
    // Not executable, wrong arch, wedged, or deleted since the stat. Caller degrades.
    return null;
  }
}

/** True when `v` is at least `min`, comparing major/minor/patch in order. */
function atLeast(v, min) {
  if (!v) return false;
  for (let i = 0; i < min.length; i++) {
    if (v[i] > min[i]) return true;
    if (v[i] < min[i]) return false;
  }
  return true;
}

/**
 * The newest candidate at or above the floor, or null. `candidates` is
 * `{ path, version }[]` in search order, `version` null when unreadable.
 * Strictly-greater replaces, so a tie keeps the earlier candidate.
 *
 * Pure on purpose, like runtimePlan: the choice is testable without binaries.
 */
function pickNewest(candidates) {
  let best = null;
  for (const candidate of candidates) {
    if (!atLeast(candidate.version, OAM_MIN)) continue;
    if (!best || !atLeast(best.version, candidate.version)) best = candidate;
  }
  return best;
}

/**
 * Where the server runs, decided BEFORE any discovery:
 *   "in-process"   import it into THIS process
 *   "discover"     choose an oam and spawn it, or fall back to Node
 *   "handoff-node" hand it off to Node on PATH: THIS process is an oam, and
 *                  Node was asked for
 *
 * `hostOam` is `process.versions.oam`: oam's own key, absent on Node. An oam
 * host whose version cannot be read is treated as below the floor -- it never
 * proved it is a supported oam -- and a host below the floor takes the
 * discovery path, whose every outcome on an oam host is a spawn or an error
 * exit, never an in-process serve. The floor is OAM_MIN itself, not a
 * parameter, so a host oam and a discovered one can never be held to different
 * minimums. There is no sandbox input because this launcher has no sandbox.
 *
 * Pure on purpose: every input is passed in, so the whole decision is testable
 * without booting a runtime.
 */
function runtimePlan({ mode, hostOam }) {
  const onOam = hostOam !== undefined;
  if (mode === "node") return onOam ? "handoff-node" : "in-process";
  return atLeast(parseVersion(hostOam ?? ""), OAM_MIN) ? "in-process" : "discover";
}

/**
 * An oam-named .cmd/.bat on PATH: a real install in a shape this launcher
 * cannot spawn. Looked up only when no usable oam was found, and then reported
 * rather than ignored, because "no oam binary was found" reads as "install oam"
 * -- the one thing that will not help. Windows only; there is no such shim
 * concept on POSIX.
 */
function findOamShim() {
  if (!isWin) return null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of [".cmd", ".bat"]) {
      const candidate = join(dir, `oam${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** A Node binary on PATH, or null. Stat-only; used only when THIS process is oam. */
function findNodeOnPath() {
  const name = isWin ? "node.exe" : "node";
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Why a candidate was passed over, for stderr. Two causes need two details: a
 * null version is NOT "old" -- the binary could not be run at all (not
 * executable, wrong arch, wedged, deleted between the stat and the probe) or
 * its output did not parse -- so it must not be described as one that needs
 * an update.
 */
function unusableReason(path, version, label = path) {
  const min = OAM_MIN.join(".");
  return version
    ? `${label} is oam ${version.join(".")}, older than ${min}`
    : `${label} could not be run, or did not report a version this launcher understands`;
}

/**
 * Choose the oam to spawn: a usable OAM_BIN, else the newest usable discovered
 * binary. Returns the choice (or null) plus what stderr needs:
 *   overrideNote     why OAM_BIN was passed over, or null
 *   skipped          why each discovered binary was passed over, when none was chosen
 *   passedOver       the `version` of every existing binary rejected (OAM_BIN
 *                    included), so a hard failure can name the right remedy
 *   overrideMissing  OAM_BIN was set to a path that does not exist
 */
function chooseOam() {
  const override = process.env.OAM_BIN;
  let overrideNote = null;
  let overrideMissing = false;
  const passedOver = [];
  if (override) {
    if (!existsSync(override)) {
      overrideNote = `OAM_BIN=${override} does not exist`;
      overrideMissing = true;
    } else {
      const version = oamVersion(override);
      if (atLeast(version, OAM_MIN)) {
        return { chosen: { path: override, version }, overrideNote, skipped: [], passedOver, overrideMissing };
      }
      overrideNote = unusableReason(override, version, `OAM_BIN=${override}`);
      passedOver.push(version);
    }
  }
  const overrideKey = override ? pathKey(override) : null;
  const candidates = discoverOamPaths()
    .filter((path) => pathKey(path) !== overrideKey)
    .map((path) => ({ path, version: oamVersion(path) }));
  const chosen = pickNewest(candidates);
  const skipped = chosen ? [] : candidates.map((c) => unusableReason(c.path, c.version));
  if (!chosen) passedOver.push(...candidates.map((c) => c.version));
  return { chosen, overrideNote, skipped, passedOver, overrideMissing };
}

/**
 * What would fix "no usable oam", one line per cause that was actually seen.
 *
 * An outdated oam is fixed by `oam self-update`; an unrunnable one is not (it
 * never ran, so updating it in place cannot help); and only when NO oam was
 * found is installing one the answer. Even that line is replaced where there is
 * nothing to install: oam publishes darwin arm64/x64, windows arm64/x64 and
 * linux x64, so on any other Linux arch "install oam" is an impossible remedy.
 */
function remedyFor({ passedOver, overrideMissing, shim }) {
  const lines = [];
  if (passedOver.some((v) => v !== null)) {
    lines.push(`Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer.\n`);
  }
  if (passedOver.some((v) => v === null)) {
    lines.push("Check that it is an executable oam binary for this platform.\n");
  }
  if (overrideMissing) lines.push("Point OAM_BIN at an existing oam binary, or unset it.\n");
  if (lines.length === 0 && !shim) {
    lines.push(
      process.platform === "linux" && process.arch !== "x64"
        ? `oam publishes no build for linux-${process.arch}, so there is nothing to install here; set OAM_BIN=/path/to/oam if you built one yourself.\n`
        : "Install oam from https://oamjs.org, or set OAM_BIN=/path/to/oam.\n",
    );
  }
  lines.push("Or use TERRAFORM_CWD_MCP_RUNTIME=node to run on Node.\n");
  return lines.join("");
}

/** Run the server in THIS process. The zero-overhead fallback. */
async function runInProcess() {
  // A server may gate its bootstrap on being the process ENTRY POINT --
  // `import.meta.url === pathToFileURL(process.argv[1]).href`. This one does not
  // today (src/index.ts starts unconditionally), but importing the server with
  // argv[1] still pointing at THIS launcher would make such a guard read false
  // and the MCP handshake hang. Point argv[1] at the server first, so the
  // in-process path is indistinguishable from having executed the file
  // directly. The spawn path needs no equivalent -- there argv[1] is already the
  // server.
  process.argv[1] = SERVER_ENTRY;
  await import(SERVER_URL.href);
}

// ONE reporter for every failed in-process fallback. runInProcess() is a bare
// import() that rejects when dist/index.js is missing or throws at load, and at
// ESM top level an unhandled rejection is an uncaught exception -- replacing
// this launcher's diagnostic with a raw stack trace.
const fallbackFailed = (e) => {
  process.stderr.write(`terraform-cwd-mcp: fallback to Node failed (${e?.message ?? e})\n`);
  process.exitCode = 1;
};

/**
 * A permission flag oam may have put in NODE_OPTIONS: `--permission` (and the
 * older `--experimental-permission`) or any `--allow-*` grant, with or without
 * an `=value`.
 */
const PERMISSION_FLAG = /^--(?:experimental-)?permission$|^--allow-[a-z0-9-]+(?:=.*)?$/;

/**
 * `env` with oam's permission flags removed from NODE_OPTIONS, or `env` itself
 * when there is nothing to remove.
 *
 * Since 0.18.0 oam appends its own `--permission` / `--allow-*` flags to every
 * child's NODE_OPTIONS, so a process started under a sandboxed oam carries them
 * in its environment. Node refuses some of them there --
 * `NODE_OPTIONS="--permission --allow-net" node` exits 9 with "--allow-net is
 * not allowed in NODE_OPTIONS" (Node 22) -- and this launcher has no sandbox to
 * pass on (see NO SANDBOX HERE), so the tokens are dropped before a child is
 * started.
 *
 * Tokens are split on whitespace with double-quoted spans kept whole, which is
 * how Node itself reads NODE_OPTIONS. Pure, so src/tests/launcher.test.ts can
 * extract and test it without booting a runtime.
 */
function stripPermissionFlags(env) {
  const raw = env.NODE_OPTIONS;
  if (!raw) return env;
  const tokens = raw.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  const kept = tokens.filter((t) => !PERMISSION_FLAG.test(t.replaceAll('"', "")));
  if (kept.length === tokens.length) return env;
  const next = { ...env };
  if (kept.length === 0) delete next.NODE_OPTIONS;
  else next.NODE_OPTIONS = kept.join(" ");
  return next;
}

/**
 * Spawn the server in a child runtime and mirror its lifetime.
 *
 * `onLaunchFailed(err)` runs when the child could not be started at all; it is
 * never called once the child is running, which would double-start the server
 * on the same stdio. The synchronous throw from spawn() and the async 'error'
 * event mean the same thing and degrade the same way.
 */
async function launchChild(cmd, args, onLaunchFailed) {
  // THIS process being an oam means one below the floor (a supported oam host
  // serves in-process) or any oam under TERRAFORM_CWD_MCP_RUNTIME=node, and an
  // old oam's `stdio: 'inherit'` does not hand over the fds. Pipe explicitly
  // from every oam host; see ALREADY RUNNING ON OAM.
  const piped = process.versions.oam !== undefined;
  let child = null;
  try {
    child = spawn(cmd, args, {
      // inherit keeps the SAME fds, so MCP's newline-delimited JSON framing on
      // stdin/stdout is untouched and the host's stdin-close still reaches the
      // server's shutdown path. Piping preserves both as well: bytes are copied
      // unchanged, and stdin's end propagates to the child.
      stdio: piped ? ["pipe", "pipe", "pipe"] : "inherit",
      // On an oam host, drop the permission flags oam put in NODE_OPTIONS; see
      // stripPermissionFlags. A Node host's env passes through untouched.
      env: process.versions.oam !== undefined ? stripPermissionFlags(process.env) : process.env,
      windowsHide: true,
    });
  } catch (err) {
    // spawn() THROWS for some failures instead of emitting 'error', and the
    // 'error' listener is registered AFTER this call, so it can never observe
    // one -- an uncaught throw here kills the launcher with a raw stack trace
    // instead of falling back.
    await onLaunchFailed(err).catch(fallbackFailed);
    return;
  }

  // If the runtime cannot be executed at all (deleted between the version probe
  // and the spawn, wrong arch, permission), fall back rather than failing the
  // whole server. `spawned` prevents falling back AFTER the child started.
  //
  // Everything that assumes a live child waits for 'spawn'. A failed spawn
  // still emits 'close' (after 'error', with the negative errno as its code), so
  // an unguarded close handler would process.exit() out from under the fallback
  // onLaunchFailed has just started -- and stdin piped into a child that never
  // ran would swallow the host's first bytes before the fallback could read
  // them. Until 'spawn', process.stdin has no reader and simply stays paused.
  let spawned = false;
  child.on("spawn", () => {
    spawned = true;
    if (piped) {
      process.stdin.pipe(child.stdin);
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    forwardSignals();
  });
  child.on("error", (err) => {
    if (spawned) return;
    onLaunchFailed(err).catch(fallbackFailed);
  });
  // A child that exits before reading everything closes its stdin; the
  // resulting EPIPE is not worth crashing over.
  child.stdin?.on("error", () => {});

  // Forward termination so the server's own shutdown path runs in the child
  // rather than the child being orphaned.
  //
  // Registering ANY handler for these suppresses Node's default
  // terminate-on-signal, so the parent's exit has to be arranged explicitly.
  // `child.killed` only records that kill() was CALLED, never that the child
  // is gone, so gating on it swallows every signal after the first and wedges
  // the launcher with no escape hatch.
  //
  // Escalation is driven by a TIMER, not by counting signals. Counting is
  // ambiguous: a supervisor routinely sends SIGINT then SIGTERM milliseconds
  // apart, and a terminal Ctrl-C reaches the whole process group, so reading
  // "a second signal" as impatience hard-kills a child that is already
  // shutting down cleanly. setTimeout is monotonic, so a wall-clock step cannot
  // mis-gate the window either.
  //
  // POSIX vs Windows, and why we do NOT forward on Windows.
  // On POSIX child.kill(sig) delivers a real, catchable signal, so forwarding
  // is what lets the child run its shutdown. On Windows there are no POSIX
  // signals: child.kill IGNORES the name and calls TerminateProcess -- an
  // immediate hard kill. Forwarding there would ABORT the graceful shutdown the
  // console's own Ctrl-C just started. The console has already notified the
  // child, so on Windows the timer below is the only kill we issue.
  //
  // 5s, as in caddy-mcp: this is a HARD kill of a server that may be in the
  // middle of a terraform command or removing tf_upgrade_impact's temp dirs,
  // and a wedged child lingering a few extra seconds costs less than cutting a
  // legitimate shutdown short.
  const ESCALATE_AFTER_MS = 5000;
  let escalation = null;
  function forwardSignals() {
    for (const sig of ["SIGINT", "SIGTERM"]) {
      process.on(sig, () => {
        // No try/catch: kill() on an already-exited child returns false, it does
        // not throw. It throws only for a signal the platform does not know,
        // which SIGINT/SIGTERM/SIGKILL never are.
        if (!isWin) child.kill(sig);
        if (escalation) return; // already counting down; further signals are noise
        escalation = setTimeout(() => {
          // Still here after its grace window. Stop waiting on it.
          child.kill("SIGKILL");
          process.exit(128 + (constants.signals[sig] ?? 15));
        }, ESCALATE_AFTER_MS);
      });
    }
  }

  // Piped: wait for 'close', so the child's last stdout bytes are copied out
  // before this process exits. Inherited: 'exit' is enough, the fds were never
  // ours to drain. Either way, only for a child that actually ran -- see the
  // 'spawn' handler above.
  child.on(piped ? "close" : "exit", (code, signal) => {
    if (!spawned) return;
    if (escalation) clearTimeout(escalation);
    // Mirror the child's fate: a signal death becomes 128+n so callers see a
    // conventional shell exit status rather than a bare 0.
    if (signal) {
      process.exit(128 + (constants.signals[signal] ?? 15));
    }
    process.exit(code ?? 0);
  });
}

/**
 * Hand the server to Node on PATH. Only reachable when THIS process is oam --
 * one below the floor, or any oam under TERRAFORM_CWD_MCP_RUNTIME=node -- so
 * there is no in-process option left.
 */
async function handOffToNode(reason) {
  const node = findNodeOnPath();
  if (!node) {
    // Two ways here, two remedies: an oam below the floor is fixed by updating
    // it, while TERRAFORM_CWD_MCP_RUNTIME=node on a supported oam asked for Node
    // outright.
    const remedy = reason
      ? `Run \`oam self-update\` to get oam ${OAM_MIN.join(".")} or newer, or launch this command with node.\n`
      : "Put Node on PATH, or unset TERRAFORM_CWD_MCP_RUNTIME to serve on this oam.\n";
    await errSync(
      `terraform-cwd-mcp: ${reason || `TERRAFORM_CWD_MCP_RUNTIME=node on oam ${process.versions.oam}`}, and no Node was found on PATH to run the server instead.\n${remedy}`,
    );
    process.exit(1);
  }
  if (reason) await errSync(`terraform-cwd-mcp: ${reason}; running on ${node} instead.\n`);
  await launchChild(node, [SERVER_ENTRY, ...process.argv.slice(2)], async (err) => {
    await errSync(`terraform-cwd-mcp: failed to launch Node at ${node} (${err?.message ?? err})\n`);
    process.exit(1);
  });
}

/**
 * No usable oam, or the chosen one would not start, under a mode that allows
 * Node. On a Node host that is THIS process; an oam host only gets here below
 * the floor (a supported one served in-process), so it hands off. `why`
 * finishes the handoff note, so a failed spawn -- already named on stderr -- is
 * not then reported as nothing being found.
 */
async function fallBackToNode(hostOam, why) {
  if (hostOam === undefined) {
    await runInProcess();
    return;
  }
  await handOffToNode(`this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}, and ${why}`);
}

const mode = (process.env.TERRAFORM_CWD_MCP_RUNTIME ?? "auto").toLowerCase();
const hostOam = process.versions.oam;
const plan = runtimePlan({ mode, hostOam });

if (plan === "in-process") {
  // Guarded like every other in-process fallback: a broken install (missing
  // dist/index.js) must print this launcher's diagnostic, not a raw Node stack
  // trace from the bare import().
  await runInProcess().catch(fallbackFailed);
} else if (plan === "handoff-node") {
  const belowFloor = !atLeast(parseVersion(hostOam), OAM_MIN);
  await handOffToNode(belowFloor ? `this process is oam ${hostOam}, older than ${OAM_MIN.join(".")}` : "");
} else {
  const { chosen, overrideNote, skipped, passedOver, overrideMissing } = chooseOam();

  if (chosen) {
    if (overrideNote)
      await errSync(`terraform-cwd-mcp: ${overrideNote}; using ${chosen.path} (oam ${chosen.version.join(".")}).\n`);
    // `--` separates oam's own flags from the script's argv, so
    // `terraform-cwd-mcp --version` and any host-supplied flags survive the hop
    // unchanged.
    await launchChild(chosen.path, ["run", SERVER_ENTRY, "--", ...process.argv.slice(2)], async (err) => {
      if (mode === "oam") {
        await errSync(`terraform-cwd-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err})\n`);
        process.exit(1);
      }
      await errSync(
        `terraform-cwd-mcp: failed to launch oam at ${chosen.path} (${err?.message ?? err}); using Node instead.\n`,
      );
      await fallBackToNode(hostOam, "the newer oam would not start");
    });
  } else {
    const shim = findOamShim();
    const notes = [
      ...(overrideNote ? [overrideNote] : []),
      ...skipped,
      ...(shim
        ? [
            `found ${shim}, but Node cannot execute a .cmd/.bat directly -- install the native oam binary, or point OAM_BIN at one`,
          ]
        : []),
    ];
    if (mode === "oam") {
      // Explicitly demanded, so this is a real misconfiguration.
      await errSync(
        `terraform-cwd-mcp: TERRAFORM_CWD_MCP_RUNTIME=oam but no usable oam (${OAM_MIN.join(".")} or newer) was found.\n` +
          notes.map((note) => `  ${note}\n`).join("") +
          remedyFor({ passedOver, overrideMissing, shim }),
      );
      process.exit(1);
    }
    // auto: falling back is correct, but silence is how someone never learns
    // their OAM_BIN is wrong or their oam is too old to use. errSync, not
    // process.stderr.write: src/index.ts answers `--version` with process.stdout.write +
    // process.exit(0), and that exit truncates a pending async stderr write.
    if (notes.length > 0) await errSync(`terraform-cwd-mcp: ${notes.join("; ")}; using Node instead.\n`);
    await fallBackToNode(hostOam, "no newer oam was found").catch(fallbackFailed);
  }
}

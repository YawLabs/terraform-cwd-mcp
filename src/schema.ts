import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Tool-facing kind -> the key `terraform providers schema -json` files it under. */
export const KINDS = {
  resource: "resource_schemas",
  data: "data_source_schemas",
  ephemeral: "ephemeral_resource_schemas",
} as const;

export type Kind = keyof typeof KINDS;

export function isKind(kind: string): kind is Kind {
  return Object.hasOwn(KINDS, kind);
}

/** Same wording as the Python prototype (`f"kind must be one of {list(KINDS)}"`). */
export const BAD_KIND_MESSAGE = `kind must be one of [${Object.keys(KINDS)
  .map((k) => `'${k}'`)
  .join(", ")}]`;

// --- Schema JSON shapes (the subset this server reads) ----------------------

export interface SchemaAttribute {
  type?: unknown;
  nested_type?: SchemaNestedType;
  description?: string;
  required?: boolean;
  optional?: boolean;
  computed?: boolean;
  deprecated?: boolean;
  sensitive?: boolean;
  write_only?: boolean;
}

export interface SchemaNestedType {
  attributes?: Record<string, SchemaAttribute>;
  nesting_mode?: string;
}

export interface SchemaBlockType {
  nesting_mode?: string;
  min_items?: number;
  max_items?: number;
  block?: SchemaBlock;
}

export interface SchemaBlock {
  attributes?: Record<string, SchemaAttribute>;
  block_types?: Record<string, SchemaBlockType>;
  description?: string;
  deprecated?: boolean;
}

export interface TypeSchema {
  version?: number;
  block?: SchemaBlock;
}

export interface ProviderSchema {
  provider?: TypeSchema;
  resource_schemas?: Record<string, TypeSchema>;
  data_source_schemas?: Record<string, TypeSchema>;
  ephemeral_resource_schemas?: Record<string, TypeSchema>;
}

export interface SchemaDump {
  format_version?: string;
  provider_schemas?: Record<string, ProviderSchema>;
}

/** A loaded root module: its resolved path, the schema dump and the lock-file versions. */
export interface LoadedRoot {
  root: string;
  data: SchemaDump;
  versions: Record<string, string>;
}

// --- Configuration ----------------------------------------------------------

export const DEFAULT_TIMEOUT_MS = 300_000;

export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERRAFORM_CWD_MCP_CACHE || join(homedir(), ".cache", "terraform-cwd-mcp");
}

/**
 * Plugin cache for tf_upgrade_impact downloads: TERRAFORM_CWD_MCP_PLUGIN_CACHE, else
 * the user's own TF_PLUGIN_CACHE_DIR (a shared cache by design), else <cacheDir>/plugins.
 */
export function defaultPluginCacheDir(cacheDir: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.TERRAFORM_CWD_MCP_PLUGIN_CACHE || env.TF_PLUGIN_CACHE_DIR || join(cacheDir, "plugins");
}

export function defaultRootDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TERRAFORM_CWD_MCP_DIR || process.cwd();
}

/**
 * Extra directories tools may use, from TERRAFORM_CWD_MCP_ALLOWED_DIRS (separated
 * like PATH). Operator configuration: no tool parameter can change it.
 */
export function parseAllowedDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.TERRAFORM_CWD_MCP_ALLOWED_DIRS ?? "")
    .split(delimiter)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      assertLocalPath(p);
      return resolve(p);
    });
}

/** Resolve symlinks and junctions; a part that does not exist yet is kept as written. */
function canonicalPath(p: string): string {
  const tail: string[] = [];
  let cur = p;
  for (;;) {
    try {
      return join(realpathSync.native(cur), ...tail);
    } catch {
      const up = dirname(cur);
      if (up === cur) return p;
      tail.unshift(basename(cur));
      cur = up;
    }
  }
}

/** True when `child` is `parent` or below it, after resolving links in both. */
export function isInsideDir(parent: string, child: string): boolean {
  const rel = relative(canonicalPath(parent), canonicalPath(child));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** setTimeout clamps anything above 2^31-1 ms to 1 ms, which would kill terraform at once. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

export function defaultTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.TERRAFORM_CWD_MCP_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1 ? Math.min(Math.floor(n), MAX_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

/**
 * Reject UNC and device paths (`\\host\share`, `//host/share`, `\\?\...`, `\\.\...`)
 * before any fs call touches them. On Windows a stat of a UNC path opens an SMB
 * connection, which can hand the user's NTLM hash to that host; a tool call
 * steered by prompt injection must not be able to trigger that.
 */
export function assertLocalPath(p: string): void {
  if (/^[\\/]{2}/.test(p)) {
    throw new Error(
      `${p} is a UNC or device path; only local directories are accepted. Pass \`dir\` as a local Terraform root module path.`,
    );
  }
}

// --- Lock file --------------------------------------------------------------

/**
 * provider address -> pinned version, parsed from .terraform.lock.hcl.
 *
 * Line-based on purpose, like the prototype: the lock file is machine-written by
 * `terraform init` in a fixed shape (`provider "<addr>" {` then `version = "<v>"`),
 * so a full HCL parser would buy nothing here.
 */
export function parseLockVersions(text: string): Record<string, string> {
  const versions: Record<string, string> = {};
  let current: string | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('provider "')) {
      current = line.split('"')[1] ?? null;
    } else if (current && line.startsWith("version")) {
      const v = line.split('"')[1];
      if (v !== undefined) versions[current] = v;
      current = null;
    }
  }
  return versions;
}

/** First 16 hex chars of sha256(resolved root path + lock file bytes). */
export function cacheKey(root: string, lockBytes: Buffer): string {
  return createHash("sha256").update(Buffer.from(root, "utf8")).update(lockBytes).digest("hex").slice(0, 16);
}

export class NotInitializedError extends Error {
  constructor(root: string, missing: string[]) {
    super(
      `${root} is not initialized (missing ${missing.join(" and ")}). ` +
        "Run `terraform init -backend=false` there first; this server never runs init itself. " +
        "Pass `dir` to point at a different root module.",
    );
    this.name = "NotInitializedError";
  }
}

/** Throws NotInitializedError unless `root` has both .terraform/ and .terraform.lock.hcl. */
export function assertInitialized(root: string): void {
  const missing: string[] = [];
  if (!isDirectory(root)) {
    throw new Error(`${root} does not exist or is not a directory. Pass \`dir\` as a Terraform root module path.`);
  }
  if (!existsSync(join(root, ".terraform.lock.hcl"))) missing.push(".terraform.lock.hcl");
  if (!existsSync(join(root, ".terraform"))) missing.push(".terraform/");
  if (missing.length > 0) throw new NotInitializedError(root, missing);
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// --- Running terraform ------------------------------------------------------

export type SchemaRunner = (root: string) => Promise<string>;

export interface RunnerOptions {
  /** Binary to run. Default: TERRAFORM_CWD_MCP_BINARY, else `terraform`. */
  binary?: string;
  timeoutMs?: number;
}

/** Result of one terraform invocation. A non-zero exit is a result, not a rejection. */
export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * What a terraform child inherits. `scrubbed` (the default) is for every command
 * that may start a provider plugin; `download` adds proxy settings and host-scoped
 * registry tokens for `terraform init` in a temp dir; `backend` is for commands that
 * read a remote backend and start no plugin. It equals `scrubbed` unless the operator
 * set TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1, because backend configuration
 * can itself run a command (an AWS `credential_process`, a kubernetes `exec`), and
 * then adds only the variables of that backend type (`BACKEND_ENV`).
 */
export type EnvProfile = "scrubbed" | "download" | "backend";

export interface ExecOptions {
  cwd: string;
  /** Extra environment entries; `null` removes a variable from the environment. */
  env?: Record<string, string | null>;
  envProfile?: EnvProfile;
  /** Backend type for the `backend` profile: selects which credential variables it adds. */
  backend?: string;
  timeoutMs?: number;
}

/**
 * Runs terraform with an args array. Rejects only when the process could not be
 * started or was killed by the timeout; everything else (including a non-zero
 * exit) is returned for the caller to interpret.
 */
export type TerraformExec = (args: string[], opts: ExecOptions) => Promise<RunResult>;

/** Cap on how much stderr is kept for the error message; stdout is never capped. */
const STDERR_CAP = 64 * 1024;

/** OS and locale variables terraform and its plugins need to start; none of them holds a credential by design. */
const BASE_ENV = new Set([
  "PATH",
  "PATHEXT",
  "HOME",
  "USER",
  "LOGNAME",
  "USERNAME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "TERM",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "TF_CLI_CONFIG_FILE",
  "TF_PLUGIN_CACHE_DIR",
  "TF_PLUGIN_CACHE_MAY_BREAK_DEPENDENCY_LOCK_FILE",
  "TF_DATA_DIR",
  "TF_WORKSPACE",
]);

const DOWNLOAD_ENV = new Set(["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR"]);

/** The variables each remote backend reads. A type not listed here gets none. */
const BACKEND_ENV: Record<string, RegExp> = {
  s3: /^AWS_/,
  gcs: /^(GOOGLE_|GCLOUD_|CLOUDSDK_)/,
  azurerm: /^(ARM_|AZURE_|MSI_|IDENTITY_ENDPOINT$|IDENTITY_HEADER$|ACTIONS_ID_TOKEN_REQUEST_)/,
  remote: /^(TF_TOKEN_|TF_CLOUD_|TFE_)/,
  cloud: /^(TF_TOKEN_|TF_CLOUD_|TFE_)/,
  http: /^TF_HTTP_/,
  consul: /^CONSUL_/,
  cos: /^TENCENTCLOUD_/,
  oss: /^(ALICLOUD_|ALIBABA_CLOUD_)/,
  kubernetes: /^(KUBE_|KUBECONFIG$)/,
  pg: /^PG/,
};

/** Operator opt-in for handing backend credential variables to terraform. */
export function backendCredentialsAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS === "1";
}

/** PATH without empty or relative entries: those resolve against cwd, which is the untrusted root. */
function absolutePathEntries(value: string): string {
  return value
    .split(delimiter)
    .filter((p) => isAbsolute(p.replace(/^"|"$/g, "")))
    .join(delimiter);
}

/**
 * Environment for a terraform child: always an allowlist, so AWS_*, TF_VAR_*,
 * TF_TOKEN_* and anything else a provider plugin could read are absent unless the
 * profile adds them. TERRAFORM_CWD_MCP_PASS_ENV (comma-separated names) adds what a
 * version-manager wrapper needs. Every profile sets CHECKPOINT_DISABLE, which stops
 * the version check terraform otherwise sends to checkpoint-api.hashicorp.com.
 */
export function terraformEnv(
  extra: Record<string, string | null> = {},
  profile: EnvProfile = "scrubbed",
  base: NodeJS.ProcessEnv = process.env,
  backend?: string,
): NodeJS.ProcessEnv {
  const passed = new Set(
    (base.TERRAFORM_CWD_MCP_PASS_ENV ?? "")
      .split(",")
      .map((n) => n.trim().toUpperCase())
      .filter(Boolean),
  );
  const backendVars =
    profile === "backend" &&
    backend !== undefined &&
    backendCredentialsAllowed(base) &&
    Object.hasOwn(BACKEND_ENV, backend)
      ? BACKEND_ENV[backend]
      : undefined;
  const keep = (name: string): boolean => {
    if (BASE_ENV.has(name) || passed.has(name)) return true;
    if (profile === "download") return DOWNLOAD_ENV.has(name) || /^TF_(TOKEN|REGISTRY)_/.test(name);
    return backendVars !== undefined && (DOWNLOAD_ENV.has(name) || backendVars.test(name));
  };
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || !keep(k.toUpperCase())) continue;
    env[k] = k.toUpperCase() === "PATH" ? absolutePathEntries(v) : v;
  }
  // Whatever terraform starts by bare name (cmd.exe for a credential_process) must not resolve in cwd.
  if (process.platform === "win32") env.NoDefaultCurrentDirectoryInExePath = "1";
  env.TF_IN_AUTOMATION = "1";
  env.TF_INPUT = "0";
  env.CHECKPOINT_DISABLE = "1";
  for (const [k, v] of Object.entries(extra)) {
    if (v === null) delete env[k];
    else env[k] = v;
  }
  return env;
}

/**
 * Create the shared terraform runner.
 *
 * spawn with an args array and no shell, so paths and the binary are never
 * re-parsed by a shell on any platform. stdout is collected as a stream of
 * Buffers rather than through execFile's maxBuffer: the AWS provider alone dumps
 * tens of MB, and any fixed buffer is a cliff somebody's provider set eventually
 * walks off.
 *
 * On Windows, a bare `terraform` resolves to `terraform.exe` on PATH, so no shell
 * is needed there either. That lookup tries cwd first, and cwd is the root an agent
 * may write to, unless NoDefaultCurrentDirectoryInExePath is set in THIS process
 * (the check reads the parent's environment; the child's does not count). So it is
 * set before every spawn. A `.cmd` / `.bat` shim cannot run without a shell (Node
 * refuses with EINVAL since CVE-2024-27980), so it is rejected up front with a
 * message naming the fix.
 */
export function createTerraformExec(opts: RunnerOptions = {}): TerraformExec {
  const binary = opts.binary ?? (process.env.TERRAFORM_CWD_MCP_BINARY || "terraform");
  const defaultTimeout = opts.timeoutMs ?? defaultTimeoutMs();
  return (args, { cwd, env, envProfile, backend, timeoutMs = defaultTimeout }) =>
    new Promise<RunResult>((resolvePromise, reject) => {
      const label = `terraform ${args.filter((a) => !a.startsWith("-")).join(" ")}`;
      if (isWindowsBatch(binary)) {
        reject(new Error(windowsBatchMessage(binary)));
        return;
      }
      if (process.platform === "win32") process.env.NoDefaultCurrentDirectoryInExePath = "1";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(binary, args, {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: terraformEnv(env, envProfile, process.env, backend),
        });
      } catch (e) {
        reject(spawnError(binary, e as NodeJS.ErrnoException));
        return;
      }
      const out: Buffer[] = [];
      let err = "";
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => {
        if (err.length < STDERR_CAP) err += chunk.toString("utf8");
      });
      child.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        reject(spawnError(binary, e));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new TimeoutError(`${label} did not finish within ${timeoutMs} ms and was killed.`, timeoutMs));
        } else {
          resolvePromise({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: err });
        }
      });
    });
}

export class TimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "TimeoutError";
  }
}

/**
 * Backend type from `.terraform/terraform.tfstate` (`backend.type`), else `local`.
 * Only `type` is read: `backend.config` can hold secrets passed via -backend-config.
 * The file is writable by whoever can write the root, and the type is printed, so
 * anything that is not a plain name becomes `unknown` (a remote type with no variables).
 */
export function backendType(root: string): string {
  const file = join(root, ".terraform", "terraform.tfstate");
  if (!existsSync(file)) return "local";
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { backend?: { type?: unknown } };
    const t = parsed.backend?.type;
    if (typeof t !== "string" || !t) return "local";
    return /^[A-Za-z0-9_-]+$/.test(t) ? t : "unknown";
  } catch {
    return "local";
  }
}

const SCHEMA_ARGS = ["providers", "schema", "-json"];
const PROVIDER_ADDRESS = /^[A-Za-z0-9.-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;

function schemaFailure(code: number | null, stderr: string): Error {
  return new Error(`terraform providers schema failed (exit ${code}):\n${stderr.trim()}`);
}

/**
 * The schema dump for a root whose backend cannot be used without credentials.
 * In the root itself `providers schema` reads state from the backend, so it runs
 * in a temp dir instead: a generated backend-less configuration naming the locked
 * providers, the root's lock file and a link to its installed packages. The
 * `terraform_data` resource makes the builtin provider part of the dump.
 */
async function isolatedSchemaDump(root: string, exec: TerraformExec): Promise<string> {
  const lock = readFileSync(join(root, ".terraform.lock.hcl"));
  const addresses = Object.keys(parseLockVersions(lock.toString("utf8")));
  const bad = addresses.find((a) => !PROVIDER_ADDRESS.test(a));
  if (bad !== undefined) {
    throw new Error(
      `.terraform.lock.hcl in ${root} names an invalid provider address (${JSON.stringify(bad)}). Run terraform init there to rewrite it.`,
    );
  }
  const tmp = mkdtempSync(join(tmpdir(), "tfcwd-schema-"));
  try {
    const required = addresses.map((a, i) => `    p${i} = { source = ${JSON.stringify(a)} }\n`).join("");
    writeFileSync(
      join(tmp, "main.tf"),
      `terraform {\n  required_providers {\n${required}  }\n}\n\nresource "terraform_data" "tfcwd_builtin" {}\n`,
      "utf8",
    );
    writeFileSync(join(tmp, ".terraform.lock.hcl"), lock);
    mkdirSync(join(tmp, ".terraform"));
    const providers = join(root, ".terraform", "providers");
    if (existsSync(providers)) {
      symlinkSync(
        realpathSync(providers),
        join(tmp, ".terraform", "providers"),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const r = await exec(SCHEMA_ARGS, { cwd: tmp, env: { TF_DATA_DIR: null, TF_WORKSPACE: null } });
    if (r.code !== 0) throw schemaFailure(r.code, r.stderr);
    return r.stdout;
  } finally {
    try {
      // Removes the link, never the packages behind it.
      rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // the startup sweep catches leftovers
    }
  }
}

/**
 * `terraform providers schema -json` for `root`, returning stdout; a failure
 * throws. It starts every provider plugin, so it always runs scrubbed. A root
 * with a configured backend is dumped through `isolatedSchemaDump`, because the
 * command would otherwise need that backend's credentials.
 */
export function createTerraformRunner(
  opts: RunnerOptions = {},
  exec: TerraformExec = createTerraformExec(opts),
): SchemaRunner {
  return async (root) => {
    if (backendType(root) === "local") {
      const r = await exec(SCHEMA_ARGS, { cwd: root });
      if (r.code === 0) return r.stdout;
      // A backend block after `init -backend=false`: the root cannot answer, the isolated dump can.
      if (!/backend initialization required/i.test(r.stderr.replace(/\s+/g, " "))) {
        throw schemaFailure(r.code, r.stderr);
      }
    }
    return isolatedSchemaDump(root, exec);
  };
}

function isWindowsBatch(binary: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && /\.(cmd|bat)$/i.test(binary);
}

function windowsBatchMessage(binary: string): string {
  return (
    `could not run '${binary}': .cmd/.bat shims cannot be spawned without a shell, and this server never uses one. ` +
    "Point TERRAFORM_CWD_MCP_BINARY at terraform.exe (or tofu.exe) instead."
  );
}

/** Map a spawn failure to a message that says what to do about it. */
export function spawnError(
  binary: string,
  e: NodeJS.ErrnoException,
  platform: NodeJS.Platform = process.platform,
): Error {
  if (e.code === "ENOENT") {
    const shimNote = platform === "win32" ? " (.cmd/.bat shims are not supported; it must resolve to an .exe)" : "";
    return new Error(
      `could not run '${binary}': not found on PATH${shimNote}. Install Terraform, or set ` +
        "TERRAFORM_CWD_MCP_BINARY to its full path.",
    );
  }
  if (e.code === "EINVAL" && platform === "win32") return new Error(windowsBatchMessage(binary));
  return new Error(`could not run '${binary}': ${e.message}`);
}

// --- Store ------------------------------------------------------------------

export interface StoreOptions {
  cacheDir?: string;
  defaultDir?: string;
  /** Schema dump runner (tests inject one). Default: `terraform providers schema -json` via `exec`. */
  runner?: SchemaRunner;
  /** Runner for every other terraform command (state, show, init in temp dirs, validate). */
  exec?: TerraformExec;
  /** Where tf_upgrade_impact keeps downloaded provider packages. */
  pluginCacheDir?: string;
  /** Directories tools may use besides `defaultDir`. Default: TERRAFORM_CWD_MCP_ALLOWED_DIRS. */
  allowedDirs?: string[];
  /** Enable tf_upgrade_impact. Default: TERRAFORM_CWD_MCP_ALLOW_UPGRADE=1. */
  allowUpgrade?: boolean;
}

/**
 * Loads and caches schema dumps per root module.
 *
 * Cache key = sha256(resolved root path + lock file bytes), so a provider
 * upgrade (which rewrites the lock file) invalidates it. Two layers: an
 * in-process map, then `<cacheDir>/<key>.json` on disk. A disk entry that does
 * not parse is treated as a miss and rewritten. A failed disk write is ignored:
 * the cache is an optimisation, never a reason to fail a tool call.
 */
export class SchemaStore {
  readonly cacheDir: string;
  readonly defaultDir: string;
  readonly exec: TerraformExec;
  readonly pluginCacheDir: string;
  readonly allowUpgrade: boolean;
  private readonly allowedDirs: string[];
  private readonly runner: SchemaRunner;
  /**
   * Keyed by resolved root, holding only that root's current lock key: a
   * provider upgrade replaces the entry instead of leaving the superseded dump
   * (tens of MB for AWS) resident for the life of the server.
   */
  private readonly mem = new Map<string, { key: string; data: SchemaDump }>();
  private readonly inflight = new Map<string, Promise<SchemaDump>>();

  constructor(opts: StoreOptions = {}) {
    this.cacheDir = opts.cacheDir ?? defaultCacheDir();
    this.defaultDir = opts.defaultDir ?? defaultRootDir();
    this.exec = opts.exec ?? createTerraformExec();
    this.runner = opts.runner ?? createTerraformRunner({}, this.exec);
    this.pluginCacheDir = opts.pluginCacheDir ?? defaultPluginCacheDir(this.cacheDir);
    this.allowUpgrade = opts.allowUpgrade ?? process.env.TERRAFORM_CWD_MCP_ALLOW_UPGRADE === "1";
    this.allowedDirs = [resolve(this.defaultDir), ...(opts.allowedDirs ?? parseAllowedDirs()).map((d) => resolve(d))];
  }

  /** Throws unless `path` is inside the server's directory or an operator-allowed one (links resolved). */
  assertAllowedDir(path: string): void {
    if (this.allowedDirs.some((d) => isInsideDir(d, path))) return;
    throw new Error(
      `${path} is outside the directories this server may use (${this.allowedDirs.join(", ")}). Start the server ` +
        "there, set TERRAFORM_CWD_MCP_DIR to it, or add it to TERRAFORM_CWD_MCP_ALLOWED_DIRS in the MCP client's " +
        "server configuration, then restart the server.",
    );
  }

  /** A tool's `dir` as an absolute path; relative paths resolve against the server's directory. */
  resolveRoot(dir?: string): string {
    const raw = dir || this.defaultDir;
    assertLocalPath(raw);
    const root = resolve(this.defaultDir, raw);
    assertLocalPath(root);
    this.assertAllowedDir(root);
    return root;
  }

  async load(dir?: string): Promise<LoadedRoot> {
    const root = this.resolveRoot(dir);
    assertInitialized(root);
    const lockBytes = readFileSync(join(root, ".terraform.lock.hcl"));
    const versions = parseLockVersions(lockBytes.toString("utf8"));
    const key = cacheKey(root, lockBytes);

    const hit = this.mem.get(root);
    if (hit && hit.key === key) return { root, data: hit.data, versions };

    let pending = this.inflight.get(key);
    if (!pending) {
      pending = this.fetch(root, key).finally(() => this.inflight.delete(key));
      this.inflight.set(key, pending);
    }
    const data = await pending;
    this.mem.set(root, { key, data });
    return { root, data, versions };
  }

  private async fetch(root: string, key: string): Promise<SchemaDump> {
    const file = join(this.cacheDir, `${key}.json`);
    if (existsSync(file)) {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as SchemaDump;
      } catch {
        // Corrupt or truncated entry: fall through and regenerate it.
      }
    }
    const stdout = await this.runner(root);
    let data: SchemaDump;
    try {
      data = JSON.parse(stdout) as SchemaDump;
    } catch (e) {
      throw new Error(
        `terraform providers schema -json did not return valid JSON (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
    this.writeCache(file, stdout);
    return data;
  }

  private writeCache(file: string, text: string): void {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(tmp, text, "utf8");
      renameSync(tmp, file);
    } catch {
      try {
        rmSync(tmp, { force: true });
      } catch {
        // best effort
      }
    }
  }
}

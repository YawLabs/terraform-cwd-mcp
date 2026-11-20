import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADDRESS_STRING_KEY,
  childMarker,
  collectSensitiveStrings,
  escapeUnsafeChars,
  type Marker,
  pairedSecretName,
  REDACTED_KEY,
  Redactor,
  SENSITIVE,
} from "./redact.js";
import {
  assertInitialized,
  backendCredentialsAllowed,
  backendType,
  type EnvProfile,
  type TerraformExec,
  TimeoutError,
} from "./schema.js";

export { backendType };

/**
 * tf_state_addresses / tf_show_resource (design-capabilities.md sections 4 and 7.3).
 *
 * Read-only by construction: `terraform state list` and `terraform show -json`
 * never call Lock and never refresh (RefreshState re-reads the stored snapshot;
 * no provider ReadResource). The one way a read can WRITE is selecting a
 * workspace that does not exist (the s3 backend PutObjects an empty state), so
 * a non-default workspace is checked against `terraform workspace list` first.
 *
 * Credentials: `terraform show` starts provider plugins, so it never gets them.
 * With a remote backend the state is fetched by `terraform state pull` (no plugin)
 * and rendered from a private temp file by a scrubbed `terraform show`. The backend
 * commands get that backend's credential variables only when the operator set
 * TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1: backend configuration lives in the
 * root and can name a command that terraform runs with them.
 */

// --- Workspace and backend ---------------------------------------------------

export interface Workspace {
  name: string;
  source: "TF_WORKSPACE" | ".terraform/environment" | "default";
}

export function selectedWorkspace(root: string, env: NodeJS.ProcessEnv = process.env): Workspace {
  const fromEnv = env.TF_WORKSPACE?.trim();
  if (fromEnv) return { name: fromEnv, source: "TF_WORKSPACE" };
  try {
    const fromFile = readFileSync(join(root, ".terraform", "environment"), "utf8").trim();
    if (fromFile) return { name: fromFile, source: ".terraform/environment" };
  } catch {
    // no file: default workspace
  }
  return { name: "default", source: "default" };
}

/** Workspace names from `terraform workspace list` output (the selected one is marked `* `). */
export function parseWorkspaceList(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*\*\s*/, "").trim())
    .filter(Boolean);
}

/**
 * Workspace name, escaped before it is printed. The name comes from
 * `.terraform/environment`, a file anyone who can write the directory controls,
 * so a name holding a newline would forge whole lines of a tool result.
 */
const wsText = (name: string) => escapeUnsafeChars(name);

export function workspaceMissingMessage(ws: Workspace, existing: string[]): string {
  return (
    `workspace '${wsText(ws.name)}' (from ${ws.source}) does not exist in the backend. Reading it would make Terraform ` +
    `create it (it writes an empty state), so this server will not. Select an existing workspace: ${existing.join(", ") || "(none listed)"}.`
  );
}

// --- Error mapping ------------------------------------------------------------

const TF_TEXT_CAP = 2048;

const CREDENTIAL_PATTERNS = [
  /no valid credential sources/i,
  /could not find default credentials/i,
  /required token could not be found/i,
  /\b40[13]\b/,
  /accessdenied/i,
  /expiredtoken/i,
  // http backend: 401 -> "HTTP remote state endpoint requires auth", 403 -> "... invalid auth" (no status number).
  /endpoint (requires|invalid) auth/i,
];

/** What to do when a remote backend failed and its variables were withheld; "" otherwise. */
function withheldEnvHint(backend: string, env: NodeJS.ProcessEnv): string {
  if (backend === "local" || backendCredentialsAllowed(env)) return "";
  return (
    "\nThis server withholds backend credential and proxy variables by default, because backend configuration can " +
    "run a command that would see them. If this backend needs them and you trust this directory, set " +
    "TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1 in the MCP client's configuration for this server and restart it."
  );
}

export function noStateMessage(ws: string, backend: string): string {
  return `No state in workspace '${wsText(ws)}' (backend ${backend}): nothing has been applied yet.`;
}

/**
 * Map a failed state command to an actionable message (first match wins), with
 * Terraform's own text appended after `terraform said:` and capped at 2 KiB.
 */
export function stateErrorMessage(
  cmd: string,
  code: number | null,
  stderr: string,
  root: string,
  backend: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hint = cmd === "show" ? "" : withheldEnvHint(backend, env);
  const flat = stderr.replace(/\s+/g, " ");
  const said = stderr.trim().slice(0, TF_TEXT_CAP);
  const suffix = said ? `\nterraform said: ${said}` : "";
  if (/another process has locked a portion of the file/i.test(flat)) {
    return (
      "The state file is locked by another Terraform process (an apply or plan is running). On Windows the local " +
      `backend's lock blocks readers too. Retry when it finishes.${suffix}`
    );
  }
  if (/backend initialization required/i.test(flat)) {
    // After `init -backend=false` there is no .terraform/terraform.tfstate, so `backend` says local;
    // Terraform's own text names the configured one.
    const requested = /requested backend "([\w-]+)"/i.exec(flat)?.[1] ?? backend;
    return (
      `The ${requested} backend is configured but not initialized here (e.g. after init -backend=false). ` +
      `Run terraform init in ${root}; this server never does.${suffix}`
    );
  }
  if (CREDENTIAL_PATTERNS.some((re) => re.test(flat))) {
    const how = hint
      ? hint.trimStart()
      : "This server passes the backend's variables from the environment its MCP client started it with; export them there and restart the client.";
    return `Could not read state from the ${backend} backend: credentials are missing or expired. ${how}${suffix}`;
  }
  if (/required plugins are not installed/i.test(flat) || /module not installed/i.test(flat)) {
    return `${root} is only partly initialized (providers or modules missing). Run terraform init there.${suffix}`;
  }
  return `terraform ${cmd} failed (exit ${code}) reading the ${backend} backend:\n${said}${hint}`;
}

export function isNoStateError(stderr: string): boolean {
  return /no state file was found/i.test(stderr);
}

// --- Running the state commands ----------------------------------------------

export interface StateContext {
  root: string;
  workspace: Workspace;
  backend: string;
  /** The env the caller resolved this context from; error hints must read it, not process.env. */
  env: NodeJS.ProcessEnv;
}

async function runState(
  exec: TerraformExec,
  ctx: StateContext,
  args: string[],
  cmd: string,
  envProfile: EnvProfile = ctx.backend === "local" ? "scrubbed" : "backend",
) {
  try {
    // TF_DATA_DIR would make the child read the workspace (and backend) from a different
    // data dir than the one the guard checked (<root>/.terraform): strip it so both agree.
    return await exec(args, { cwd: ctx.root, env: { TF_DATA_DIR: null }, envProfile, backend: ctx.backend });
  } catch (e) {
    if (e instanceof TimeoutError) {
      const hint = envProfile === "backend" ? withheldEnvHint(ctx.backend, ctx.env) : "";
      throw new Error(
        `terraform ${cmd} did not finish within ${e.timeoutMs} ms (backend ${ctx.backend}); the backend may be unreachable.${hint}`,
      );
    }
    throw e;
  }
}

/**
 * Preconditions shared by both state tools: local path + initialized root
 * (callers resolve the root), and the workspace guard.
 */
export async function prepareState(
  exec: TerraformExec,
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StateContext> {
  assertInitialized(root);
  const ctx: StateContext = { root, workspace: selectedWorkspace(root, env), backend: backendType(root), env };
  if (ctx.workspace.name !== "default") {
    const r = await runState(exec, ctx, ["workspace", "list", "-no-color"], "workspace list");
    if (r.code !== 0)
      throw new Error(stateErrorMessage("workspace list", r.code, r.stderr, root, ctx.backend, ctx.env));
    const names = parseWorkspaceList(r.stdout);
    if (!names.includes(ctx.workspace.name)) throw new Error(workspaceMissingMessage(ctx.workspace, names));
  }
  return ctx;
}

/** `terraform state list`: the addresses, or null when there is no state. */
export async function listStateAddresses(
  exec: TerraformExec,
  ctx: StateContext,
  id?: string,
): Promise<string[] | null> {
  const args = ["state", "list", "-no-color"];
  if (id !== undefined) args.push(`-id=${id}`);
  const r = await runState(exec, ctx, args, "state list");
  if (r.code !== 0) {
    if (isNoStateError(r.stderr)) return null;
    throw new Error(stateErrorMessage("state list", r.code, r.stderr, ctx.root, ctx.backend, ctx.env));
  }
  return r.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** `terraform state pull`: the raw state text, or null when there is none. */
async function pullState(exec: TerraformExec, ctx: StateContext): Promise<string | null> {
  const pull = await runState(exec, ctx, ["state", "pull"], "state pull");
  if (pull.code !== 0) {
    if (isNoStateError(pull.stderr)) return null;
    throw new Error(stateErrorMessage("state pull", pull.code, pull.stderr, ctx.root, ctx.backend, ctx.env));
  }
  return pull.stdout.trim() ? pull.stdout : null;
}

/** Remote backend: a scrubbed `show` of a pulled copy (`pulled`, else pulled here). */
async function showPulledState(exec: TerraformExec, ctx: StateContext, pulled?: string | null) {
  const text = pulled === undefined ? await pullState(exec, ctx) : pulled;
  if (text === null) return null;
  const tmp = mkdtempSync(join(tmpdir(), "tfcwd-state-"));
  try {
    const file = join(tmp, "state.json");
    writeFileSync(file, text, { encoding: "utf8", mode: 0o600 });
    return await runState(exec, ctx, ["show", "-json", "-no-color", file], "show", "scrubbed");
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** `terraform show -json` of the current state, or null when there is no state. */
export async function showState(
  exec: TerraformExec,
  ctx: StateContext,
  pulled?: string | null,
): Promise<StateDoc | null> {
  const r =
    ctx.backend === "local"
      ? await runState(exec, ctx, ["show", "-json", "-no-color"], "show")
      : await showPulledState(exec, ctx, pulled);
  if (r === null) return null;
  if (r.code !== 0) {
    if (isNoStateError(r.stderr)) return null;
    throw new Error(stateErrorMessage("show", r.code, r.stderr, ctx.root, ctx.backend, ctx.env));
  }
  let doc: StateDoc;
  try {
    doc = JSON.parse(r.stdout) as StateDoc;
  } catch {
    // No parser detail: it quotes the input, and this input is state.
    throw new Error("terraform show -json did not return valid JSON.");
  }
  return doc.values ? doc : null;
}

// --- What tf_state_addresses may print ---------------------------------------------

const ADDRESS_INDEX = String.raw`(?:\[(?:\d+|"(?:[^"\\]|\\.)*")\])?`;
const ADDRESS_PART = String.raw`[^\s"[\].]+${ADDRESS_INDEX}`;
/** One line of `terraform state list`: dot-separated names, each with an optional instance key. */
const ADDRESS_LINE = new RegExp(String.raw`^${ADDRESS_PART}(?:\.${ADDRESS_PART})+$`);
const STATE_NAME = /^[^\s"[\].]+$/;

function untrustedListMessage(ctx: StateContext): string {
  return (
    `The state of workspace '${wsText(ctx.workspace.name)}' (backend ${ctx.backend}) holds a resource name that is not a valid ` +
    "Terraform name, so the lines of terraform state list cannot be told apart and none are printed. The state was " +
    "probably edited by hand: restore it from a backup (terraform.tfstate.backup for the local backend) or repair it, " +
    "and check who can write it."
  );
}

/**
 * True when every name in raw state could have come from a configuration. Terraform
 * prints resource names unescaped, so a name holding a newline forges whole lines, and
 * those can look like valid addresses: only the state itself can expose them.
 */
function stateNamesAreValid(pulled: string): boolean {
  let doc: unknown;
  try {
    doc = JSON.parse(pulled);
  } catch {
    return false;
  }
  const resources = (doc as { resources?: unknown } | null)?.resources;
  if (resources === undefined) return true;
  if (!Array.isArray(resources)) return false;
  return resources.every((r: { type?: unknown; name?: unknown; module?: unknown } | null) => {
    if (typeof r?.type !== "string" || typeof r.name !== "string") return false;
    if (!STATE_NAME.test(r.type) || !STATE_NAME.test(r.name)) return false;
    if (r.module === undefined) return true;
    return typeof r.module === "string" && escapeUnsafeChars(r.module) === r.module;
  });
}

export interface ShownAddresses {
  addresses: string[];
  /** Printed after the list when something about it needs saying. */
  note?: string;
}

/**
 * Turn `terraform state list` output into what may be printed: refuse output that
 * cannot be trusted, then hide secret instance keys. Knowing which keys are sensitive
 * takes `terraform show -json` (it starts plugins), so that runs only when some
 * address has a string key. If it cannot run, every string key is hidden.
 */
export async function addressesForDisplay(
  exec: TerraformExec,
  ctx: StateContext,
  addresses: string[],
): Promise<ShownAddresses> {
  if (addresses.length === 0) return { addresses };
  if (!addresses.every((a) => ADDRESS_LINE.test(a))) throw new Error(untrustedListMessage(ctx));
  const pulled = await pullState(exec, ctx);
  if (pulled !== null && !stateNamesAreValid(pulled)) throw new Error(untrustedListMessage(ctx));
  let sensitive = new Set<string>();
  if (addresses.some((a) => a.includes('["'))) {
    try {
      sensitive = collectSensitiveStrings(await showState(exec, ctx, pulled));
    } catch {
      return {
        addresses: addresses.map((a) => escapeUnsafeChars(a.replace(ADDRESS_STRING_KEY, `["${REDACTED_KEY}"]`))),
        note:
          "note: every string instance key is hidden, because terraform show could not run here to say which are " +
          `sensitive. Run terraform init in ${ctx.root} if its providers are missing.`,
      };
    }
  }
  const redactor = new Redactor(sensitive);
  return { addresses: addresses.map((a) => redactor.address(a)) };
}

// --- Rendering ------------------------------------------------------------------

/** `addresses` are printed as given: pass them through `addressesForDisplay` first. */
export function renderAddresses(
  addresses: string[] | null,
  ctx: Pick<StateContext, "workspace" | "backend">,
  filter: string | undefined,
  id: string | undefined,
  limit: number,
  note?: string,
): string {
  if (addresses === null) return noStateMessage(ctx.workspace.name, ctx.backend);
  const hits = filter ? addresses.filter((a) => a.includes(filter)) : addresses;
  if (hits.length === 0) {
    if (filter) return `no addresses match '${filter}'${id !== undefined ? ` with id '${id}'` : ""}`;
    if (id !== undefined) return `no resource instance has id '${id}'`;
  }
  const what = [filter ? `matching '${filter}'` : "", id !== undefined ? `with id '${id}'` : ""]
    .filter(Boolean)
    .join(" ");
  const head = `${hits.length} addresses${what ? ` ${what}` : ""} in workspace '${wsText(ctx.workspace.name)}' (backend ${ctx.backend})`;
  const more = hits.length > limit ? [`... ${hits.length - limit} more, narrow the filter`] : [];
  return [head, ...hits.slice(0, limit), ...more, ...(note ? [note] : [])].join("\n");
}

export interface StateResource {
  address: string;
  mode?: string;
  type?: string;
  name?: string;
  index?: unknown;
  provider_name?: string;
  schema_version?: number;
  values?: Record<string, unknown>;
  sensitive_values?: Marker;
  deposed_key?: string;
  tainted?: boolean;
}

interface StateModule {
  address?: string;
  resources?: StateResource[];
  child_modules?: StateModule[];
}

export interface StateDoc {
  format_version?: string;
  terraform_version?: string;
  values?: { outputs?: Record<string, unknown>; root_module?: StateModule };
}

export function allResources(doc: StateDoc): StateResource[] {
  const out: StateResource[] = [];
  const visit = (m: StateModule | undefined) => {
    if (!m) return;
    out.push(...(m.resources ?? []));
    for (const c of m.child_modules ?? []) visit(c);
  };
  visit(doc.values?.root_module);
  return out;
}

/** `registry.terraform.io/hashicorp/tls` -> `hashicorp/tls`; other hosts are kept. */
export function shortProvider(addr: string | undefined): string {
  if (!addr) return "?";
  return addr.replace(/^registry\.terraform\.io\//, "");
}

const IDENT_KEY = /^[a-z_][a-z0-9_]*$/;

function pathJoin(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  if (IDENT_KEY.test(key)) return path ? `${path}.${key}` : key;
  return `${path}[${escapeUnsafeChars(JSON.stringify(key))}]`;
}

function quoteTruncated(s: string, max: number): string {
  if (max > 0 && s.length > max) return `${JSON.stringify(s.slice(0, max))} ... (+${s.length - max} chars)`;
  return JSON.stringify(s);
}

export interface ShowOptions {
  includeNull: boolean;
  maxValueChars: number;
}

/**
 * Flatten one resource's values to `path = value` lines, redacted. Object keys
 * that are lowercase identifiers render dotted (`input.pw`), anything else in
 * brackets (`tags["Name"]`): state JSON does not say which objects are maps.
 */
export function renderResource(res: StateResource, sensitive: Set<string>, opts: ShowOptions): string {
  const redactor = new Redactor(sensitive);
  const lines: string[] = [];
  const walk = (value: unknown, marker: Marker, path: string, keys: string[]) => {
    if (marker === true) {
      if (value === null && !opts.includeNull) return;
      redactor.counts.marked++;
      lines.push(`  ${path} = ${SENSITIVE}`);
      return;
    }
    if (value === null || value === undefined) {
      if (opts.includeNull) lines.push(`  ${path} = null`);
      return;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`  ${path} = []`);
        return;
      }
      for (const [i, v] of value.entries()) walk(v, childMarker(marker, i), pathJoin(path, i), keys);
      return;
    }
    if (typeof value === "object") {
      const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      if (entries.length === 0) {
        lines.push(`  ${path} = {}`);
        return;
      }
      // `{ name = "DB_PASSWORD", value = "x" }`: the value is named by its sibling, not by "value".
      const paired = pairedSecretName(value as Record<string, unknown>);
      for (const [k, v] of entries) {
        const childKeys = paired !== null && k === "value" ? [...keys, k, paired] : [...keys, k];
        walk(v, childMarker(marker, k), pathJoin(path, redactor.keyLabel(k)), childKeys);
      }
      return;
    }
    if (typeof value === "string") {
      const r = redactor.redactString(value, keys);
      lines.push(`  ${path} = ${"replaced" in r ? r.replaced : quoteTruncated(r.value, opts.maxValueChars)}`);
      return;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      lines.push(`  ${path} = ${redactor.redactScalar(value, keys) ?? String(value)}`);
      return;
    }
    lines.push(`  ${path} = ${String(value)}`);
  };
  const values = res.values ?? {};
  for (const [k, v] of Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    walk(v, childMarker(res.sensitive_values, k), pathJoin("", k), [k]);
  }
  const kind = escapeUnsafeChars(String(res.mode === "data" ? `data ${res.type}` : res.type));
  const deposed = res.deposed_key ? ` [deposed ${escapeUnsafeChars(res.deposed_key)}]` : "";
  const flags = `${deposed}${res.tainted ? " [tainted]" : ""}`;
  const provider = escapeUnsafeChars(shortProvider(res.provider_name));
  const head = `${redactor.address(res.address)}${flags} (${kind}, ${provider}, schema v${res.schema_version ?? 0})`;
  const footer = redactor.footer();
  return [head, ...(lines.length ? lines : ["  (no attribute values)"]), ...(footer ? [footer] : [])].join("\n");
}

/** Answer for tf_show_resource given a rendered state document. */
export function showResource(doc: StateDoc, address: string, opts: ShowOptions): string {
  const resources = allResources(doc);
  const sensitive = collectSensitiveStrings(doc);
  const redactor = new Redactor(sensitive);
  // An address as tf_state_addresses printed it, hidden keys included, selects the instance too.
  const matches = resources.filter((r) => r.address === address || redactor.address(r.address) === address);
  if (matches.length > 0) {
    return matches.map((r) => renderResource(r, sensitive, opts)).join("\n\n");
  }
  const instances = [
    ...new Set(resources.filter((r) => r.address.startsWith(`${address}[`)).map((r) => redactor.address(r.address))),
  ];
  if (instances.length > 0) {
    return `${address} has ${instances.length} instances; pass one: ${instances.join(", ")}`;
  }
  return `${address} is not in state. Use tf_state_addresses to list addresses.`;
}

import { existsSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { loadModule, type ModuleCallDecl, type ModuleConfig, type VariableDecl } from "./config.js";
import { satisfies } from "./constraints.js";
import type { HclValue } from "./hcl.js";
import { moduleFiles } from "./hcl.js";
import { hasSecretShape, isSecretKey, maskInlineSecrets, REDACTED_NAME } from "./redact.js";
import { assertLocalPath } from "./schema.js";

/**
 * tf_module_interface (design-capabilities.md section 7.2): the variables,
 * outputs and module calls of the root, a local module directory, or an
 * installed module addressed as `module.a.module.b`. Reads files only; no
 * subprocess.
 */

export interface ManifestEntry {
  Key: string;
  Source?: string;
  Version?: string;
  Dir: string;
}

/** `.terraform/modules/modules.json`, or null when it is missing or unreadable. */
export function readManifest(root: string): ManifestEntry[] | null {
  const file = join(root, ".terraform", "modules", "modules.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")) as { Modules?: ManifestEntry[] };
    return Array.isArray(parsed.Modules) ? parsed.Modules.filter((m) => typeof m?.Dir === "string") : null;
  } catch {
    return null;
  }
}

/** `module.a.module.b` (instance keys allowed and ignored) -> manifest key `a.b`; null when not an address. */
export function addressToKey(address: string): string | null {
  const stripped = address.trim().replace(/\[[^\]]*\]/g, "");
  if (!/^module\.[^.]+(\.module\.[^.]+)*$/.test(stripped)) return null;
  return stripped
    .split(".")
    .filter((_, i) => i % 2 === 1)
    .join(".");
}

export function keyToAddress(key: string): string {
  return key
    .split(".")
    .map((k) => `module.${k}`)
    .join(".");
}

const LOCAL_PREFIX = /^\.\.?[\\/]/;
const SCP_STYLE = /^([^@/:]+)@([^:/]+):\/?([^/].*)$/;

/** posix `path.Clean` as Go defines it (Terraform cleans local module sources with it). */
function goPathClean(p: string): string {
  const rooted = p.startsWith("/");
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!rooted) out.push("..");
      continue;
    }
    out.push(seg);
  }
  const joined = out.join("/");
  if (rooted) return `/${joined}`;
  return joined || ".";
}

/** `host/owner/repo[//sub][?query]` -> `git::https://host/owner/repo.git[//sub][?query]` (go-getter's GitHub detector). */
function gitHttpsShorthand(s: string): string | null {
  const m = /^(github\.com|bitbucket\.org)\/([^/?]+)\/([^/?]+)((?:\/[^?]*)?)(\?.*)?$/.exec(s);
  if (!m) return null;
  const [, host, owner, repo, rest = "", query = ""] = m;
  const sub = rest.replace(/^\/+/, "");
  return `git::https://${host}/${owner}/${repo!.endsWith(".git") ? repo : `${repo}.git`}${sub ? `//${sub}` : ""}${query}`;
}

/**
 * Normalize a module source the way Terraform does before it records it in
 * `.terraform/modules/modules.json` (addrs.ParseModuleSource), so the two can
 * be compared: local paths are path-cleaned with a leading `./` kept, GitHub /
 * Bitbucket shorthands become `git::https://...git`, scp-style `user@host:path`
 * becomes `git::ssh://user@host/path`, and registry sources gain the default host.
 */
export function normalizeModuleSource(source: string): string {
  const s = source.trim();
  if (LOCAL_PREFIX.test(s)) {
    const clean = goPathClean(s.replace(/\\/g, "/"));
    return clean.startsWith("../") ? clean : `./${clean}`;
  }
  if (s.includes("::") || s.includes("://") || /^[a-z]:/i.test(s)) return s;
  const scp = SCP_STYLE.exec(s);
  if (scp) {
    const [, user, host, path] = scp;
    return `git::ssh://${user}@${host}/${path}`;
  }
  const git = gitHttpsShorthand(s);
  if (git !== null) return git;
  const parts = s.split("//")[0]!.split("/");
  if (parts.length === 3 && !parts[0]!.includes(".")) return `registry.terraform.io/${s}`;
  return s;
}

const displayPath = (root: string, p: string): string => {
  const rel = relative(root, p);
  if (rel === "") return ".";
  if (rel.startsWith("..") || isAbsolute(rel)) return p;
  return rel.split("\\").join("/");
};

export interface ResolvedModule {
  dir: string;
  /** Path shown in the header (relative to root when inside it). */
  display: string;
  /** Manifest key (`""` for the root), when known. */
  key: string | null;
}

export function resolveModule(
  root: string,
  module: string | undefined,
  manifest: ManifestEntry[] | null,
): ResolvedModule {
  if (module === undefined || module.trim() === "" || module.trim() === ".")
    return { dir: root, display: "(root)", key: "" };
  const key = addressToKey(module);
  if (key !== null) {
    const entry = manifest?.find((e) => e.Key === key);
    if (!entry) {
      throw new Error(
        `${keyToAddress(key)} is not in .terraform/modules/modules.json (not installed, or not called from ${root}). ` +
          "Run terraform init, or pass a directory path.",
      );
    }
    assertLocalPath(entry.Dir);
    const dir = resolve(root, entry.Dir);
    return { dir, display: displayPath(root, dir), key };
  }
  assertLocalPath(module);
  const dir = resolve(root, module);
  assertLocalPath(dir);
  const entry = manifest?.find((e) => resolve(root, e.Dir) === dir);
  return { dir, display: displayPath(root, dir), key: entry ? entry.Key : null };
}

// --- Rendering ------------------------------------------------------------------------

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function describe(v: HclValue | undefined, max: number): string {
  if (!v) return "";
  let d =
    v.kind === "literal"
      ? typeof v.value === "string"
        ? collapse(v.value)
        : JSON.stringify(v.value)
      : `expr(${v.text})`;
  if (max && d.length > max) d = `${d.slice(0, max)}...`;
  return d;
}

function containsSecretShape(v: unknown): boolean {
  if (typeof v === "string") return hasSecretShape(v);
  if (Array.isArray(v)) return v.some(containsSecretShape);
  if (v && typeof v === "object") return Object.values(v).some(containsSecretShape);
  return false;
}

/**
 * The literal default with redaction layers 3 and 4 applied the way redact.ts
 * applies them to state: a value under a secret-like key (any depth) is
 * replaced, and URL passwords / inline `password=...` credentials are masked.
 */
function redactDefaultValue(v: unknown, underSecretKey: boolean): unknown {
  if (underSecretKey && v !== null && typeof v !== "object") return REDACTED_NAME;
  if (typeof v === "string") return maskInlineSecrets(v) ?? v;
  if (Array.isArray(v)) return v.map((x) => redactDefaultValue(x, underSecretKey));
  if (v && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map(([k, x]) => [k, redactDefaultValue(x, underSecretKey || isSecretKey(k))]),
    );
  }
  return v;
}

const DEFAULT_CHARS = 80;

function renderDefault(v: VariableDecl): string {
  if (!v.hasDefault || !v.default) return "";
  if (v.sensitive || isSecretKey(v.name)) return " default=(sensitive)";
  const d = v.default;
  if (d.kind === "literal" ? containsSecretShape(d.value) : hasSecretShape(d.text)) {
    return " default=(redacted: secret-like value)";
  }
  let s =
    d.kind === "literal"
      ? JSON.stringify(redactDefaultValue(d.value, false))
      : `expr(${maskInlineSecrets(d.text) ?? d.text})`;
  if (s.length > DEFAULT_CHARS) s = `${s.slice(0, DEFAULT_CHARS)}...`;
  return ` default=${s}`;
}

export function renderVariable(v: VariableDecl, descChars: number): string {
  const type = v.typeText ?? "any (no type)";
  const flags = [
    v.sensitive ? " [sensitive]" : "",
    v.nullable ? "" : " [not nullable]",
    v.ephemeral ? " [ephemeral]" : "",
    v.validations ? ` [${v.validations} validation${v.validations === 1 ? "" : "s"}]` : "",
  ].join("");
  const desc = describe(v.description, descChars);
  return `  ${v.name}: ${type} ${v.hasDefault ? "optional" : "required"}${flags}${renderDefault(v)}${desc ? ` - ${desc}` : ""}`;
}

function callTarget(
  root: string,
  ownKey: string | null,
  call: ModuleCallDecl,
  manifest: ManifestEntry[] | null,
): string {
  const source =
    call.source?.kind === "literal" && typeof call.source.value === "string" ? call.source.value : undefined;
  const version =
    call.version?.kind === "literal" && typeof call.version.value === "string" ? call.version.value : undefined;
  const key = ownKey === null ? null : ownKey ? `${ownKey}.${call.name}` : call.name;
  const entry = key === null ? undefined : manifest?.find((e) => e.Key === key);
  if (!entry) return "NOT INSTALLED (run terraform init)";
  if (
    source !== undefined &&
    entry.Source !== undefined &&
    normalizeModuleSource(source) !== normalizeModuleSource(entry.Source)
  ) {
    return `STALE: installed from ${entry.Source}, config says ${source}; run terraform init`;
  }
  if (version !== undefined && entry.Version) {
    try {
      if (!satisfies(entry.Version, version)) {
        return `STALE: installed ${entry.Version}, config requires ${version}; run terraform init`;
      }
    } catch {
      // unparsable constraint: terraform init will say so
    }
  }
  return `${displayPath(root, resolve(root, entry.Dir))}${entry.Version ? ` (installed ${entry.Version})` : ""}`;
}

const byName = <T extends { name: string }>(a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function renderModuleInterface(
  root: string,
  resolved: ResolvedModule,
  m: ModuleConfig,
  manifest: ManifestEntry[] | null,
  descChars: number,
): string {
  const vars = [...m.variables.values()].sort(byName);
  const outs = [...m.outputs.values()].sort(byName);
  const calls = [...m.moduleCalls.values()].sort(byName);
  const label =
    resolved.key === "" ? "(root)" : `${resolved.display}${resolved.key ? ` (${keyToAddress(resolved.key)})` : ""}`;
  const lines = [`module ${label}: ${vars.length} variables, ${outs.length} outputs, ${calls.length} module calls`];
  if (m.errors.length > 0) {
    for (const e of m.errors.slice(0, 5)) lines.push(`parse error: ${e.file}:${e.line}`);
    lines.push("(the file did not parse cleanly; what parsed is shown, and terraform validate is the authority)");
  }
  if (vars.length) lines.push("variables:", ...vars.map((v) => renderVariable(v, descChars)));
  if (outs.length) {
    lines.push("outputs:");
    for (const o of outs) {
      const desc = describe(o.description, descChars);
      lines.push(
        `  ${o.name}${o.sensitive ? " [sensitive]" : ""}${o.ephemeral ? " [ephemeral]" : ""}${desc ? ` - ${desc}` : ""}`,
      );
    }
  }
  if (calls.length) {
    lines.push("module calls:");
    for (const c of calls) {
      const src = c.source ? (c.source.kind === "literal" ? String(c.source.value) : `expr(${c.source.text})`) : "?";
      const ver = c.version
        ? ` version=${c.version.kind === "literal" ? String(c.version.value) : `expr(${c.version.text})`}`
        : "";
      lines.push(`  ${c.name}: source=${src}${ver} -> ${callTarget(root, resolved.key, c, manifest)}`);
    }
  }
  return lines.join("\n");
}

/** The whole tool: resolve, read, render. */
export async function moduleInterface(root: string, module: string | undefined, descChars: number): Promise<string> {
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    // reported below
  }
  if (!isDir)
    throw new Error(`${root} does not exist or is not a directory. Pass \`dir\` as a Terraform root module path.`);
  const manifest = readManifest(root);
  const resolved = resolveModule(root, module, manifest);
  let files: { primary: string[]; override: string[] };
  try {
    files = moduleFiles(resolved.dir);
  } catch {
    throw new Error(`${resolved.dir} does not exist or is not a directory.`);
  }
  if (files.primary.length + files.override.length === 0) {
    return `${resolved.display === "(root)" ? root : resolved.display} contains no .tf or .tf.json files.`;
  }
  const m = await loadModule(resolved.dir);
  return renderModuleInterface(root, resolved, m, manifest, descChars);
}

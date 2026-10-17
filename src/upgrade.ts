import { createHash } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadModule,
  type ModuleConfig,
  normalizeProviderSource,
  type ProviderBlockDecl,
  type ProviderRequirement,
  type ResourceDecl,
  resourceProviderSource,
  sameProvider,
} from "./config.js";
import { bumpKind, compareVersions, EXACT_VERSION_RE, isExactPin, parseVersion, satisfies } from "./constraints.js";
import type { Body } from "./hcl.js";
import { keyToAddress, readManifest } from "./module.js";
import {
  assertInitialized,
  assertLocalPath,
  KINDS,
  type Kind,
  type ProviderSchema,
  parseLockVersions,
  type SchemaAttribute,
  type SchemaBlock,
  type SchemaBlockType,
  type SchemaDump,
  type SchemaStore,
  TimeoutError,
} from "./schema.js";

/**
 * tf_upgrade_impact (design-capabilities.md sections 6 and 7.4): compare the
 * pinned provider schema with a target version's schema for the arguments this
 * configuration actually uses, then confirm with `terraform validate` on a temp
 * copy. The user's directory is never written: the target provider is
 * downloaded by `terraform init` in a throwaway dir (into a plugin cache), and
 * validate runs on a copy whose `.terraform/providers` entries are links to the
 * already-installed packages.
 */

// --- Provider addresses and the lock file ------------------------------------------

export interface ProviderAddr {
  full: string;
  host: string;
  namespace: string;
  type: string;
}

export function splitAddr(full: string): ProviderAddr {
  const [host = "", namespace = "", type = ""] = full.split("/");
  return { full, host, namespace, type };
}

/** `hashicorp/tls` or `registry.terraform.io/hashicorp/tls` -> the matching lock-file address, or null. */
export function resolveProviderAddress(input: string, versions: Record<string, string>): string | null {
  const s = input.trim().toLowerCase();
  const parts = s.split("/");
  if (parts.some((p) => p === "")) return null;
  if (parts.length === 3) return Object.hasOwn(versions, s) ? s : null;
  if (parts.length === 1) {
    // A bare type (`local`): accepted when exactly one locked provider has it.
    const byType = Object.keys(versions).filter((a) => a.endsWith(`/${s}`));
    return byType.length === 1 ? byType[0]! : null;
  }
  if (parts.length !== 2) return null;
  const preferred = `registry.terraform.io/${s}`;
  if (Object.hasOwn(versions, preferred)) return preferred;
  const matches = Object.keys(versions).filter((a) => a.endsWith(`/${s}`));
  return matches.length === 1 ? matches[0]! : null;
}

export function shortAddr(full: string): string {
  return full.replace(/^registry\.terraform\.io\//, "");
}

/** The `provider "<addr>" { ... }` block of a lock file (through its closing `}` line), or null. */
export function extractLockBlock(text: string, addr: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `provider "${addr}" {`);
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.trimEnd() === "}");
  if (end < 0) return null;
  return lines.slice(start, end + 1).join("\n");
}

/** Replace (or append) the block for `addr` in a lock file. */
export function replaceLockBlock(text: string, addr: string, block: string): string {
  const existing = extractLockBlock(text.replace(/\r\n/g, "\n"), addr);
  const normalized = text.replace(/\r\n/g, "\n");
  if (existing === null) return `${normalized.trimEnd()}\n\n${block}\n`;
  return normalized.replace(existing, () => block);
}

// --- Schema paths -----------------------------------------------------------------------

export type Resolved =
  | { kind: "attr"; attr: SchemaAttribute }
  | { kind: "block"; bt: SchemaBlockType }
  | { kind: "missing" }
  | { kind: "opaque" };

/** Resolve a path the way tf_check_arguments walks it: attributes, nested attributes, nested blocks. */
export function resolvePath(block: SchemaBlock | undefined, path: string[]): Resolved {
  let attrs = block?.attributes ?? {};
  let blocks = block?.block_types ?? {};
  for (let i = 0; i < path.length; i++) {
    const part = path[i]!;
    const last = i === path.length - 1;
    if (Object.hasOwn(attrs, part)) {
      const a = attrs[part]!;
      if (last) return { kind: "attr", attr: a };
      if (a.type === undefined && a.nested_type?.attributes) {
        attrs = a.nested_type.attributes;
        blocks = {};
        continue;
      }
      return { kind: "opaque" };
    }
    if (Object.hasOwn(blocks, part)) {
      const bt = blocks[part]!;
      if (last) return { kind: "block", bt };
      attrs = bt.block?.attributes ?? {};
      blocks = bt.block?.block_types ?? {};
      continue;
    }
    return { kind: "missing" };
  }
  return { kind: "block", bt: { block } };
}

const settable = (a: SchemaAttribute) => Boolean(a.required || a.optional);

function typeText(a: SchemaAttribute): string {
  if (a.type !== undefined) return typeof a.type === "string" ? a.type : JSON.stringify(a.type);
  return `nested:${a.nested_type?.nesting_mode ?? "?"}`;
}

/**
 * Type of one attribute without its nested attributes: for a nested attribute
 * only the nesting mode counts, because each inner key the configuration sets
 * is checked as its own path.
 */
function shallowTypeSignature(a: SchemaAttribute): string {
  return a.type !== undefined ? JSON.stringify(a.type) : `nested:${a.nested_type?.nesting_mode}`;
}

function typeSignature(a: SchemaAttribute): string {
  if (a.type !== undefined) return JSON.stringify(a.type);
  const inner = Object.entries(a.nested_type?.attributes ?? {})
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}:${typeSignature(v)}`);
  return `nested:${a.nested_type?.nesting_mode}{${inner.join(",")}}`;
}

// --- Usage collection ---------------------------------------------------------------------

export interface MetaNames {
  args: Set<string>;
  blocks: Set<string>;
}

/** Meta-arguments of resource / data / ephemeral blocks (not schema arguments). */
export const RESOURCE_META: MetaNames = {
  args: new Set(["count", "for_each", "provider", "depends_on"]),
  blocks: new Set(["lifecycle", "provisioner", "connection"]),
};

/** Meta-arguments of `provider` configuration blocks. */
export const PROVIDER_META: MetaNames = { args: new Set(["alias", "version"]), blocks: new Set() };

export interface ArgUse {
  path: string[];
  file: string;
  line: number;
  /** A key of an object literal: only meaningful when the parent is a nested attribute. */
  viaObject?: boolean;
}

export interface LevelUse {
  prefix: string[];
  names: Set<string>;
  /** Static occurrences of each nested block type at this level (dynamic blocks are not counted). */
  blockCounts: Map<string, number>;
  dynamic: Set<string>;
  file: string;
  line: number;
}

export interface BlockUsage {
  args: ArgUse[];
  levels: LevelUse[];
}

export function collectBodyUsage(body: Body, file: string, line: number, meta: MetaNames = RESOURCE_META): BlockUsage {
  const out: BlockUsage = { args: [], levels: [] };
  const walk = (b: Body, prefix: string[], at: number) => {
    const level: LevelUse = { prefix, names: new Set(), blockCounts: new Map(), dynamic: new Set(), file, line: at };
    out.levels.push(level);
    const top = prefix.length === 0;
    for (const a of b.attrs) {
      if (top && meta.args.has(a.name)) continue;
      out.args.push({ path: [...prefix, a.name], file: a.file, line: a.line });
      level.names.add(a.name);
      for (const k of a.objectKeys ?? []) {
        out.args.push({ path: [...prefix, a.name, k.name], file: a.file, line: k.line || a.line, viaObject: true });
      }
    }
    for (const blk of b.blocks) {
      if (top && meta.blocks.has(blk.type)) continue;
      if (blk.type === "dynamic") {
        const name = blk.labels[0];
        if (!name) continue;
        out.args.push({ path: [...prefix, name], file: blk.file, line: blk.line });
        level.names.add(name);
        level.dynamic.add(name);
        const content = blk.body.blocks.find((x) => x.type === "content");
        if (content) walk(content.body, [...prefix, name], content.line);
        continue;
      }
      out.args.push({ path: [...prefix, blk.type], file: blk.file, line: blk.line });
      level.names.add(blk.type);
      level.blockCounts.set(blk.type, (level.blockCounts.get(blk.type) ?? 0) + 1);
      walk(blk.body, [...prefix, blk.type], blk.line);
    }
  };
  walk(body, [], line);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** JSON-syntax body: whether a key is an attribute or a nested block is decided by the pinned schema. */
export function collectJsonUsage(
  json: Record<string, unknown>,
  schema: SchemaBlock | undefined,
  file: string,
  meta: MetaNames = RESOURCE_META,
): BlockUsage {
  const out: BlockUsage = { args: [], levels: [] };
  const walk = (obj: Record<string, unknown>, sb: SchemaBlock | undefined, prefix: string[]) => {
    const level: LevelUse = { prefix, names: new Set(), blockCounts: new Map(), dynamic: new Set(), file, line: 0 };
    out.levels.push(level);
    const top = prefix.length === 0;
    for (const [k, v] of Object.entries(obj)) {
      if (k === "//" || (top && (meta.args.has(k) || meta.blocks.has(k)))) continue;
      if (k === "dynamic" && isObj(v)) {
        for (const [name, d] of Object.entries(v)) {
          out.args.push({ path: [...prefix, name], file, line: 0 });
          level.names.add(name);
          level.dynamic.add(name);
          const content = isObj(d) ? d.content : undefined;
          const bt = sb?.block_types?.[name];
          if (isObj(content)) walk(content, bt?.block, [...prefix, name]);
        }
        continue;
      }
      out.args.push({ path: [...prefix, k], file, line: 0 });
      level.names.add(k);
      const bt = sb?.block_types && Object.hasOwn(sb.block_types, k) ? sb.block_types[k] : undefined;
      if (bt) {
        const items = Array.isArray(v) ? v : [v];
        level.blockCounts.set(k, items.length);
        for (const item of items) if (isObj(item)) walk(item, bt.block, [...prefix, k]);
      } else if (isObj(v)) {
        for (const key of Object.keys(v)) out.args.push({ path: [...prefix, k, key], file, line: 0, viaObject: true });
      }
    }
  };
  walk(json, schema, []);
  return out;
}

// --- Modules of a root ----------------------------------------------------------------------

export interface ModuleUnit {
  /** Manifest key: "" for the root. */
  key: string;
  /** `module.a.module.b`, or "" for the root. */
  address: string;
  dir: string;
  /** Directory relative to the root with `/` separators ("" for the root). */
  display: string;
  config: ModuleConfig;
}

function relDisplay(root: string, p: string): string {
  const rel = relative(root, p);
  if (rel === "") return "";
  if (isAbsolute(rel)) return p.split(sep).join("/");
  return rel.split(sep).join("/");
}

/** False for a UNC or device path: touching one on Windows opens SMB (and can leak the NTLM hash). */
function isLocalPath(p: string): boolean {
  try {
    assertLocalPath(p);
    return true;
  } catch {
    return false;
  }
}

/** The root plus every module in `.terraform/modules/modules.json` (local and downloaded). */
export async function loadModules(root: string): Promise<ModuleUnit[]> {
  const units: ModuleUnit[] = [{ key: "", address: "", dir: root, display: "", config: await loadModule(root) }];
  const manifest = readManifest(root) ?? [];
  // A manifest Dir that is a UNC/device path is skipped before any fs call.
  const entries = manifest
    .filter((e) => e.Key !== "" && isLocalPath(e.Dir))
    .sort((a, b) => (a.Key < b.Key ? -1 : a.Key > b.Key ? 1 : 0));
  for (const e of entries) {
    const dir = resolve(root, e.Dir);
    if (!existsSync(dir)) continue;
    units.push({
      key: e.Key,
      address: keyToAddress(e.Key),
      dir,
      display: relDisplay(root, dir),
      config: await loadModule(dir),
    });
  }
  return units;
}

// --- Findings ---------------------------------------------------------------------------------

export interface Finding {
  label: string;
  where: string;
  message: string;
  severity: "breaking" | "deprecation";
  /** `<kind> <type>.<path>` key, to keep used findings out of the include_unused list. */
  key: string;
}

function whereOf(unit: ModuleUnit, file: string, line: number): string {
  const f = unit.display ? `${unit.display}/${file}` : file;
  return line > 0 ? `${f}:${line}` : f;
}

function resourceLabel(unit: ModuleUnit, r: ResourceDecl): string {
  const mode = r.mode === "data" ? "data." : r.mode === "ephemeral" ? "ephemeral." : "";
  return `${unit.address ? `${unit.address}.` : ""}${mode}${r.type}.${r.name}`;
}

const KIND_OF: Record<ResourceDecl["mode"], Kind> = { resource: "resource", data: "data", ephemeral: "ephemeral" };

function typeSchema(p: ProviderSchema | undefined, kind: Kind, type: string) {
  const rec = p?.[KINDS[kind]];
  return rec && Object.hasOwn(rec, type) ? rec[type] : undefined;
}

export interface UsageReport {
  usedTypes: { kind: Kind; type: string }[];
  findings: Finding[];
  /**
   * Every `<kind> <type>[.<path>]` (and `provider <type>.<path>`) key the
   * configuration sets or reads, plus every finding key: what include_unused
   * leaves out.
   */
  usedKeys: Set<string>;
}

interface CompareContext {
  unit: ModuleUnit;
  /** Label prefix, e.g. `module.a.tls_private_key.k` or `provider kubernetes`. */
  base: string;
  /** Key prefix, e.g. `resource tls_private_key` or `provider kubernetes`. */
  keyBase: string;
  version: string;
  add: (f: Finding) => void;
  used: Set<string>;
}

/** Compare one block's argument paths and nested-block levels between the pinned and target schema. */
function compareUsage(
  usage: BlockUsage,
  pBlock: SchemaBlock | undefined,
  tBlock: SchemaBlock | undefined,
  c: CompareContext,
): void {
  const v = c.version;
  const { unit, base, keyBase, add } = c;
  for (const arg of usage.args) {
    const pr = resolvePath(pBlock, arg.path);
    if (pr.kind === "missing" || pr.kind === "opaque") continue;
    const key = `${keyBase}.${arg.path.join(".")}`;
    c.used.add(key);
    const tr = resolvePath(tBlock, arg.path);
    const label = `${base}.${arg.path.join(".")}`;
    const w = whereOf(unit, arg.file, arg.line);
    const breaking = (message: string) => add({ label, where: w, message, severity: "breaking", key });
    const deprecation = (message: string) => add({ label, where: w, message, severity: "deprecation", key });
    if (tr.kind === "missing") {
      breaking(`REMOVED in ${v}`);
      continue;
    }
    if (tr.kind === "opaque") continue;
    if (pr.kind === "attr" && tr.kind === "block") {
      breaking(`now a nested block in ${v} (was an attribute)`);
      continue;
    }
    if (pr.kind === "block" && tr.kind === "attr") {
      breaking(`now an attribute in ${v} (was a nested block)`);
      continue;
    }
    if (pr.kind === "attr" && tr.kind === "attr") {
      if (settable(pr.attr) && !settable(tr.attr)) breaking(`now READ-ONLY (computed) in ${v}`);
      else if (shallowTypeSignature(pr.attr) !== shallowTypeSignature(tr.attr)) {
        breaking(`TYPE CHANGED ${typeText(pr.attr)} -> ${typeText(tr.attr)} in ${v}`);
      } else if (tr.attr.deprecated && !pr.attr.deprecated) deprecation(`DEPRECATED in ${v}`);
      continue;
    }
    if (pr.kind === "block" && tr.kind === "block") {
      const level = usage.levels.find((l) => l.prefix.join(".") === arg.path.slice(0, -1).join("."));
      const name = arg.path[arg.path.length - 1]!;
      const count = level?.dynamic.has(name) ? undefined : level?.blockCounts.get(name);
      const tMin = tr.bt.min_items ?? 0;
      const pMin = pr.bt.min_items ?? 0;
      const tMax = tr.bt.max_items ?? 0;
      if (count !== undefined && tMin > pMin && count < tMin) {
        breaking(`min_items raised to ${tMin} in ${v} (configuration has ${count})`);
      } else if (count !== undefined && tMax > 0 && count > tMax && !(pr.bt.max_items && pr.bt.max_items < count)) {
        breaking(`max_items lowered to ${tMax} in ${v} (configuration has ${count})`);
      } else if (tr.bt.block?.deprecated && !pr.bt.block?.deprecated) {
        deprecation(`DEPRECATED in ${v}`);
      }
    }
  }
  // Newly required arguments / blocks at every block level the configuration writes.
  for (const level of usage.levels) {
    const pl = resolvePath(pBlock, level.prefix);
    const tl = resolvePath(tBlock, level.prefix);
    if (pl.kind !== "block" || tl.kind !== "block") continue;
    const pb = pl.bt.block;
    const tb = tl.bt.block;
    for (const [name, a] of Object.entries(tb?.attributes ?? {})) {
      if (!a.required || level.names.has(name)) continue;
      if (pb?.attributes && Object.hasOwn(pb.attributes, name) && pb.attributes[name]!.required) continue;
      const path = [...level.prefix, name];
      add({
        label: `${base}.${path.join(".")}`,
        where: whereOf(unit, level.file, level.line),
        message: `NEWLY REQUIRED in ${v}, not set`,
        severity: "breaking",
        key: `${keyBase}.${path.join(".")}`,
      });
    }
    for (const [name, bt] of Object.entries(tb?.block_types ?? {})) {
      if (!(bt.min_items && bt.min_items > 0) || level.names.has(name)) continue;
      const pbt = pb?.block_types && Object.hasOwn(pb.block_types, name) ? pb.block_types[name] : undefined;
      if (pbt?.min_items && pbt.min_items > 0) continue;
      const path = [...level.prefix, name];
      add({
        label: `${base}.${path.join(".")}`,
        where: whereOf(unit, level.file, level.line),
        message: `NEWLY REQUIRED block in ${v}, not set`,
        severity: "breaking",
        key: `${keyBase}.${path.join(".")}`,
      });
    }
  }
}

/** Provider source a `provider "<local>"` block configures, through required_providers. */
function providerBlockSource(m: ModuleConfig, pb: ProviderBlockDecl): string {
  const req = m.requiredProviders.get(pb.local);
  return normalizeProviderSource(req?.source ?? `hashicorp/${pb.local}`);
}

/**
 * Compare every argument path, nested-block level and attribute read of blocks
 * using `addr`, plus the arguments of its `provider` configuration blocks.
 */
export function usageFindings(
  units: ModuleUnit[],
  addr: string,
  pinned: ProviderSchema | undefined,
  target: ProviderSchema | undefined,
  version: string,
): UsageReport {
  const findings: Finding[] = [];
  const usedTypes: { kind: Kind; type: string }[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();
  const add = (f: Finding) => {
    used.add(f.key);
    // A block-count finding is about the block type, not each occurrence: report it once.
    const id = /_items (raised|lowered)/.test(f.message)
      ? `${f.label}|${f.message}`
      : `${f.label}|${f.where}|${f.message}`;
    if (seen.has(id)) return;
    seen.add(id);
    findings.push(f);
  };
  const v = version;
  const providerType = splitAddr(addr).type;

  for (const unit of units) {
    const prefix = unit.address ? `${unit.address}.` : "";
    // Provider configuration blocks (`provider "x" { ... }`, aliases included).
    for (const pb of unit.config.providerBlocks) {
      if (!sameProvider(providerBlockSource(unit.config, pb), addr)) continue;
      const pBlock = pinned?.provider?.block;
      if (!pBlock) continue;
      const usage = pb.json
        ? collectJsonUsage(pb.json, pBlock, pb.file, PROVIDER_META)
        : collectBodyUsage(pb.body, pb.file, pb.line, PROVIDER_META);
      compareUsage(usage, pBlock, target?.provider?.block, {
        unit,
        base: `${prefix}provider ${pb.local}${pb.alias ? `[${pb.alias}]` : ""}`,
        keyBase: `provider ${providerType}`,
        version: v,
        add,
        used,
      });
    }

    for (const r of unit.config.resources) {
      if (!sameProvider(resourceProviderSource(unit.config, r), addr)) continue;
      const kind = KIND_OF[r.mode];
      if (!usedTypes.some((u) => u.kind === kind && u.type === r.type)) usedTypes.push({ kind, type: r.type });
      used.add(`${kind} ${r.type}`);
      const p = typeSchema(pinned, kind, r.type);
      const t = typeSchema(target, kind, r.type);
      const base = resourceLabel(unit, r);
      const where = whereOf(unit, r.file, r.line);
      if (!p) continue; // already invalid at the pinned version; validate reports it
      if (!t) {
        add({ label: base, where, message: `TYPE REMOVED in ${v}`, severity: "breaking", key: `${kind} ${r.type}` });
        continue;
      }
      if (t.block?.deprecated && !p.block?.deprecated) {
        add({
          label: base,
          where,
          message: `type DEPRECATED in ${v}`,
          severity: "deprecation",
          key: `${kind} ${r.type}`,
        });
      }
      const usage = r.json ? collectJsonUsage(r.json, p.block, r.file) : collectBodyUsage(r.body, r.file, r.line);
      compareUsage(usage, p.block, t.block, { unit, base, keyBase: `${kind} ${r.type}`, version: v, add, used });
    }

    // Attribute reads: <type>.<name>[idx|*].<attr>, data.<type>.<name>.<attr>, ephemeral.<type>.<name>.<attr>.
    for (const ref of unit.config.refs) {
      let mode: ResourceDecl["mode"] = "resource";
      let steps = ref.steps;
      if (steps[0] === "data" || steps[0] === "ephemeral") {
        mode = steps[0];
        steps = steps.slice(1);
      }
      const [type, name, ...rest] = steps;
      if (!type || !name || name.startsWith("[")) continue;
      const decl = unit.config.resources.find((r) => r.mode === mode && r.type === type && r.name === name);
      if (!decl || !sameProvider(resourceProviderSource(unit.config, decl), addr)) continue;
      const attr = rest.find((s) => !s.startsWith("["));
      if (!attr) continue;
      const kind = KIND_OF[mode];
      const p = typeSchema(pinned, kind, type);
      const t = typeSchema(target, kind, type);
      if (!p || !t) continue;
      const pr = resolvePath(p.block, [attr]);
      const tr = resolvePath(t.block, [attr]);
      if (pr.kind === "missing") continue;
      // Same key as a set argument, so include_unused leaves a read attribute out.
      const key = `${kind} ${type}.${attr}`;
      used.add(key);
      const modePrefix = mode === "resource" ? "" : `${mode}.`;
      const label = `reads ${prefix}${modePrefix}${type}.${name}.${attr}`;
      const where = whereOf(unit, ref.file, ref.line);
      if (tr.kind === "missing") add({ label, where, message: `REMOVED in ${v}`, severity: "breaking", key });
      else if (pr.kind === "attr" && tr.kind === "attr" && tr.attr.deprecated && !pr.attr.deprecated) {
        add({ label, where, message: `DEPRECATED in ${v}`, severity: "deprecation", key });
      }
    }
  }
  return { usedTypes, findings, usedKeys: used };
}

/** Changes in the target schema for this provider that the configuration does not use (include_unused). */
export function unusedChanges(
  pinned: ProviderSchema | undefined,
  target: ProviderSchema | undefined,
  usedKeys: Set<string>,
  providerType = "provider",
): string[] {
  const out: string[] = [];
  // The provider configuration block (`provider "<type>" { ... }`).
  diffBlock(pinned?.provider?.block, target?.provider?.block, [], (path, msg) => {
    const key = `provider ${[providerType, ...path].join(".")}`;
    if (!usedKeys.has(key)) out.push(`  ${key}: ${msg}`);
  });
  const sorted = (rec: Record<string, unknown> | undefined) => Object.keys(rec ?? {});
  for (const kind of Object.keys(KINDS) as Kind[]) {
    const names = [...new Set([...sorted(pinned?.[KINDS[kind]]), ...sorted(target?.[KINDS[kind]])])].sort();
    for (const name of names) {
      const p = typeSchema(pinned, kind, name);
      const t = typeSchema(target, kind, name);
      const emit = (path: string[], msg: string) => {
        const key = `${kind} ${[name, ...path].join(".")}`;
        if (!usedKeys.has(key)) out.push(`  ${key}: ${msg}`);
      };
      if (p && !t) {
        if (!usedKeys.has(`${kind} ${name}`)) out.push(`  ${kind} ${name}: TYPE REMOVED`);
        continue;
      }
      if (!p && t) {
        out.push(`  ${kind} ${name}: NEW type${t.block?.deprecated ? " [deprecated]" : ""}`);
        continue;
      }
      if (!p || !t) continue;
      if (t.block?.deprecated && !p.block?.deprecated && !usedKeys.has(`${kind} ${name}`))
        out.push(`  ${kind} ${name}: type DEPRECATED`);
      diffBlock(p.block, t.block, [], emit);
    }
  }
  return out;
}

function diffAttrs(
  pa: Record<string, SchemaAttribute> | undefined,
  ta: Record<string, SchemaAttribute> | undefined,
  path: string[],
  emit: (path: string[], msg: string) => void,
): void {
  const names = [...new Set([...Object.keys(pa ?? {}), ...Object.keys(ta ?? {})])].sort();
  for (const n of names) {
    const p = pa && Object.hasOwn(pa, n) ? pa[n] : undefined;
    const t = ta && Object.hasOwn(ta, n) ? ta[n] : undefined;
    const at = [...path, n];
    if (p && !t) emit(at, "REMOVED");
    else if (!p && t)
      emit(at, t.required ? "NEW REQUIRED argument" : settable(t) ? "new argument" : "new read-only attribute");
    else if (p && t) {
      // SDKv2's legacy `id` flips optional+computed -> computed in every 2.x -> 3.x pair; only a config setting it cares.
      if (settable(p) && !settable(t)) {
        if (!(n === "id" && path.length === 0)) emit(at, "now READ-ONLY (computed)");
      } else if (!p.required && t.required) emit(at, "NEWLY REQUIRED");
      else if (typeSignature(p) !== typeSignature(t)) {
        if (p.nested_type && t.nested_type) diffAttrs(p.nested_type.attributes, t.nested_type.attributes, at, emit);
        else emit(at, `TYPE CHANGED ${typeText(p)} -> ${typeText(t)}`);
      } else if (t.deprecated && !p.deprecated) emit(at, "DEPRECATED");
    }
  }
}

function diffBlock(
  p: SchemaBlock | undefined,
  t: SchemaBlock | undefined,
  path: string[],
  emit: (path: string[], msg: string) => void,
): void {
  diffAttrs(p?.attributes, t?.attributes, path, emit);
  const pb = p?.block_types ?? {};
  const tb = t?.block_types ?? {};
  for (const n of [...new Set([...Object.keys(pb), ...Object.keys(tb)])].sort()) {
    const x = Object.hasOwn(pb, n) ? pb[n] : undefined;
    const y = Object.hasOwn(tb, n) ? tb[n] : undefined;
    const at = [...path, n];
    if (x && !y) emit(at, "block REMOVED");
    else if (!x && y) emit(at, y.min_items ? "NEW REQUIRED block" : "new block");
    else if (x && y) {
      if ((y.min_items ?? 0) > (x.min_items ?? 0)) emit(at, `block min_items raised to ${y.min_items}`);
      if (y.block?.deprecated && !x.block?.deprecated) emit(at, "block DEPRECATED");
      diffBlock(x.block, y.block, at, emit);
    }
  }
}

// --- Constraints -------------------------------------------------------------------------------

export interface ConstraintReport {
  parts: string[];
  blocked: string[];
}

function requirementsFor(unit: ModuleUnit, addr: string): ProviderRequirement[] {
  const reqs: ProviderRequirement[] = [];
  const locals = new Set<string>();
  for (const req of unit.config.requiredProviders.values()) {
    if (sameProvider(normalizeProviderSource(req.source ?? `hashicorp/${req.local}`), addr)) {
      locals.add(req.local);
      if (req.version) reqs.push(req);
    }
  }
  const implied = splitAddr(addr);
  if (implied.namespace === "hashicorp" && !unit.config.requiredProviders.has(implied.type)) locals.add(implied.type);
  for (const legacy of unit.config.legacyProviderVersions) if (locals.has(legacy.local)) reqs.push(legacy);
  return reqs;
}

export function constraintReport(units: ModuleUnit[], addr: string, version: string): ConstraintReport {
  const parts: string[] = [];
  const blocked: string[] = [];
  const short = shortAddr(addr);
  for (const unit of units) {
    const reqs = requirementsFor(unit, addr);
    const name = unit.address || "root";
    if (reqs.length === 0) {
      if (!unit.address) parts.push("root: no version constraint");
      continue;
    }
    for (const req of reqs) {
      const c = req.version!;
      let ok: boolean;
      try {
        ok = satisfies(version, c);
      } catch {
        parts.push(`${name} "${c}" (unparsable constraint)`);
        continue;
      }
      const local = req.local !== splitAddr(addr).type ? ` as local name ${req.local}` : "";
      if (ok) parts.push(`${name} "${c}" ok`);
      else if (!unit.address) {
        parts.push(
          `root ${isExactPin(c) ? `pins ${c.replace(/^=\s*/, "")}` : `requires "${c}"`}${local} (change it to allow ${version})`,
        );
      } else {
        parts.push(`${name} "${c}" BLOCKED`);
        blocked.push(
          `BLOCKED: ${name} requires ${short} ${c} (${whereOf(unit, req.file, req.line)}); terraform init -upgrade would fail until that module allows ${version}.`,
        );
      }
    }
  }
  return { parts, blocked };
}

// --- Validate diagnostics -------------------------------------------------------------------------

export interface Diagnostic {
  severity?: string;
  summary?: string;
  detail?: string;
  address?: string;
  range?: { filename?: string; start?: { line?: number } };
}

export interface ValidateResult {
  diagnostics?: Diagnostic[];
}

function diagKey(d: Diagnostic): string {
  return [
    d.severity,
    d.summary,
    (d.range?.filename ?? "").split("\\").join("/"),
    d.range?.start?.line ?? "",
    d.address ?? "",
  ].join("|");
}

export interface DiagDiff {
  newErrors: Diagnostic[];
  newWarnings: Diagnostic[];
  resolvedErrors: Diagnostic[];
  resolvedWarnings: Diagnostic[];
}

/** Multiset difference of diagnostics by (severity, summary, filename, start line, address). */
export function diffDiagnostics(baseline: ValidateResult, target: ValidateResult): DiagDiff {
  const count = (list: Diagnostic[]) => {
    const m = new Map<string, number>();
    for (const d of list) m.set(diagKey(d), (m.get(diagKey(d)) ?? 0) + 1);
    return m;
  };
  const minus = (a: Diagnostic[], b: Diagnostic[]) => {
    const remaining = count(b);
    return a.filter((d) => {
      const k = diagKey(d);
      const n = remaining.get(k) ?? 0;
      if (n > 0) {
        remaining.set(k, n - 1);
        return false;
      }
      return true;
    });
  };
  const b = baseline.diagnostics ?? [];
  const t = target.diagnostics ?? [];
  const added = minus(t, b);
  const removed = minus(b, t);
  return {
    newErrors: added.filter((d) => d.severity === "error"),
    newWarnings: added.filter((d) => d.severity !== "error"),
    resolvedErrors: removed.filter((d) => d.severity === "error"),
    resolvedWarnings: removed.filter((d) => d.severity !== "error"),
  };
}

const DETAIL_CHARS = 300;

export function renderDiagnostic(d: Diagnostic): string {
  const file = d.range?.filename ? d.range.filename.split("\\").join("/") : "";
  const line = d.range?.start?.line;
  const loc = file ? ` ${file}${line ? `:${line}` : ""}` : "";
  const addr = d.address ? ` ${d.address}` : "";
  let detail = (d.detail ?? "").replace(/\s+/g, " ").trim();
  if (detail.length > DETAIL_CHARS) detail = `${detail.slice(0, DETAIL_CHARS)}...`;
  return `  ${d.severity ?? "?"}${loc}${addr}: ${d.summary ?? ""}${detail ? ` - ${detail}` : ""}`;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

// --- Rendering --------------------------------------------------------------------------------------

export interface ImpactInput {
  root: string;
  addr: string;
  pinnedVersion: string;
  targetVersion: string;
  usage: Pick<UsageReport, "usedTypes" | "findings">;
  constraints: ConstraintReport;
  validate: { diff: DiagDiff } | { skipped: string } | null;
  unused?: string[];
}

const MAX_LISTED = 50;

export function renderImpact(x: ImpactInput): string {
  const short = shortAddr(x.addr);
  const from = parseVersion(x.pinnedVersion)!;
  const to = parseVersion(x.targetVersion)!;
  const bump = bumpKind(from, to);
  const direction = compareVersions(to, from) < 0 ? `${bump} downgrade` : bump;
  const lines = [`upgrade ${short} ${x.pinnedVersion} -> ${x.targetVersion} (${direction}) for ${x.root}`];
  lines.push(`constraints: ${x.constraints.parts.join("; ") || "none"}`);
  lines.push(...x.constraints.blocked);

  const byKind = (Object.keys(KINDS) as Kind[])
    .map((k) => {
      const types = x.usage.usedTypes.filter((u) => u.kind === k).map((u) => u.type);
      return types.length ? `${k} ${types.join(", ")}` : "";
    })
    .filter(Boolean);
  lines.push(`used types: ${byKind.join("; ") || `none (no block in this configuration uses ${short})`}`);

  const f = x.usage.findings;
  if (f.length === 0) lines.push("affected arguments: none");
  else {
    lines.push(`affected arguments (${f.length}):`);
    for (const item of f.slice(0, MAX_LISTED)) lines.push(`  ${item.label} (${item.where}): ${item.message}`);
    if (f.length > MAX_LISTED) lines.push(`  ... ${f.length - MAX_LISTED} more`);
  }

  let newErrors = 0;
  let newWarnings = 0;
  let skipped: string | null = null;
  if (x.validate === null) skipped = "validate not requested";
  else if ("skipped" in x.validate) {
    skipped = x.validate.skipped;
    lines.push(`validate: skipped (${skipped})`);
  } else {
    const d = x.validate.diff;
    newErrors = d.newErrors.length;
    newWarnings = d.newWarnings.length;
    // New errors stop validate before it evaluates references, so the baseline's
    // diagnostics are hidden, not fixed: do not call them resolved.
    const resolved =
      newErrors > 0 && d.resolvedWarnings.length + d.resolvedErrors.length > 0
        ? [
            `${plural(d.resolvedWarnings.length + d.resolvedErrors.length, "baseline diagnostic")} not re-checked (validate stopped at the new errors)`,
          ]
        : [
            `${plural(d.resolvedWarnings.length, "warning")} resolved`,
            ...(d.resolvedErrors.length ? [`${plural(d.resolvedErrors.length, "error")} resolved`] : []),
          ];
    lines.push(
      `validate on a temp copy, ${x.targetVersion} vs ${x.pinnedVersion}: ${plural(newErrors, "new error")}, ${plural(newWarnings, "new warning")}, ${resolved.join(", ")}`,
    );
    for (const list of [d.newErrors, d.newWarnings]) {
      lines.push(...list.slice(0, MAX_LISTED).map(renderDiagnostic));
      if (list.length > MAX_LISTED) lines.push(`  ... ${list.length - MAX_LISTED} more`);
    }
  }

  if (x.unused) {
    lines.push(`other changes in ${x.targetVersion}, not used by this configuration (${x.unused.length}):`);
    lines.push(...x.unused.slice(0, 200));
    if (x.unused.length > 200) lines.push(`  ... ${x.unused.length - 200} more`);
  }

  const breaking = f.filter((i) => i.severity === "breaking").length;
  const deprecations = f.length - breaking;
  let verdict: string;
  if (skipped === null) {
    if (newErrors > 0) verdict = `BREAKING (${plural(newErrors, "error")} after upgrade)`;
    else if (breaking > 0)
      verdict = `BREAKING (${plural(breaking, "breaking finding")}; terraform validate reported no new errors)`;
    else if (deprecations > 0 || newWarnings > 0) verdict = "DEPRECATIONS ONLY";
    else verdict = "NO IMPACT on used types";
  } else {
    const only = ` (schema comparison only: ${skipped})`;
    if (breaking > 0) verdict = `BREAKING (${plural(breaking, "breaking finding")})${only}`;
    else if (deprecations > 0) verdict = `DEPRECATIONS ONLY${only}`;
    else verdict = `NO IMPACT on used types${only}`;
  }
  if (x.constraints.blocked.length > 0) {
    verdict = `BLOCKED (${plural(x.constraints.blocked.length, "module constraint")} exclude ${x.targetVersion})${verdict.startsWith("BREAKING") ? `; also ${verdict}` : ""}`;
  }
  lines.push(`verdict: ${verdict}`);
  return lines.join("\n");
}

// --- Target schema (download into a throwaway dir + plugin cache) -----------------------------------

export class UpgradeInputError extends Error {}

/** Map a failed target `terraform init` to a message. */
export function targetInitErrorMessage(stderr: string, addr: string, version: string, platform: string): string {
  const flat = stderr.replace(/\s+/g, " ");
  const short = shortAddr(addr);
  const { host } = splitAddr(addr);
  if (/no available releases match the given constraints/i.test(flat)) {
    return `${short} ${version} does not exist in the registry. The official terraform MCP server's provider lookup lists valid versions.`;
  }
  if (/does not have a provider named/i.test(flat)) return `${host} has no provider ${short}.`;
  if (/does not have a package available for your current platform|is not available for/i.test(flat)) {
    return `${short} ${version} has no build for ${platform}.`;
  }
  if (
    /could not connect to|failed to request discovery document|dial tcp|proxyconnect|no such host|timeout/i.test(flat)
  ) {
    return `could not reach the provider registry to download ${short} ${version} (offline or proxy). Nothing in the root module was changed.\nterraform said: ${stderr.trim().slice(0, 2048)}`;
  }
  return `terraform init failed while downloading ${short} ${version} (in a temp dir; nothing in the root module was changed):\n${stderr.trim().slice(0, 2048)}`;
}

function atomicWrite(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
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

const TEMP_PREFIXES = ["tfcwd-upgrade-", "tfcwd-target-"];

/** Delete leftover temp dirs from crashed runs (older than `maxAgeMs`). Never follows links. */
export function sweepStaleTempDirs(maxAgeMs = 3_600_000, base = tmpdir()): void {
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return;
  }
  const now = Date.now();
  for (const n of names) {
    if (!TEMP_PREFIXES.some((p) => n.startsWith(p))) continue;
    const p = join(base, n);
    try {
      if (now - lstatSync(p).mtimeMs > maxAgeMs) rm(p, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
    } catch {
      // vanished
    }
  }
}

export interface TargetSchema {
  data: SchemaDump;
  lockBlock: string;
}

/** Run a terraform command in the target temp dir, turning a timeout into a message that says where it ran. */
async function tempDirExec(
  store: SchemaStore,
  args: string[],
  cwd: string,
  env: Record<string, string | null>,
  what: string,
) {
  try {
    return await store.exec(args, { cwd, env });
  } catch (e) {
    if (e instanceof TimeoutError) {
      throw new UpgradeInputError(
        `${what} timed out after ${e.timeoutMs} ms (in a temp dir; nothing in the root module was changed). ` +
          "Raise TERRAFORM_CWD_MCP_TIMEOUT_MS or retry.",
      );
    }
    throw e;
  }
}

/**
 * The target version's schema and lock block: from the disk cache, else by
 * `terraform init` in a throwaway dir (which also fills the plugin cache). With
 * `needPackage` (validate requested), a cache hit also needs the provider
 * package in the plugin cache; when it is gone (pruned cache, changed
 * TF_PLUGIN_CACHE_DIR) the target is downloaded again, and the cached schema is
 * still used if that download fails (validate then reports the missing package).
 */
export async function loadTargetSchema(
  store: SchemaStore,
  addr: string,
  version: string,
  platform: string,
  needPackage = false,
): Promise<TargetSchema> {
  const key = `target-${createHash("sha256").update(`${addr}\n${version}\n${platform}`).digest("hex").slice(0, 16)}`;
  const jsonFile = join(store.cacheDir, `${key}.json`);
  const lockFile = join(store.cacheDir, `${key}.lock.hcl`);
  let cached: TargetSchema | null = null;
  if (existsSync(jsonFile) && existsSync(lockFile)) {
    try {
      const data = JSON.parse(readFileSync(jsonFile, "utf8")) as SchemaDump;
      const lockBlock = readFileSync(lockFile, "utf8");
      if (data.provider_schemas?.[addr] && lockBlock.includes(`provider "${addr}"`)) cached = { data, lockBlock };
    } catch {
      // corrupt entry: refetch
    }
  }
  const pkg = join(store.pluginCacheDir, ...addr.split("/"), version, platform);
  if (cached && (!needPackage || existsSync(pkg))) return cached;
  try {
    return await downloadTargetSchema(store, addr, version, platform, jsonFile, lockFile);
  } catch (e) {
    if (cached) return cached;
    throw e;
  }
}

async function downloadTargetSchema(
  store: SchemaStore,
  addr: string,
  version: string,
  platform: string,
  jsonFile: string,
  lockFile: string,
): Promise<TargetSchema> {
  const { type } = splitAddr(addr);
  const short = shortAddr(addr);
  mkdirSync(store.pluginCacheDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "tfcwd-target-"));
  try {
    writeFileSync(
      join(tmp, "main.tf"),
      `terraform {\n  required_providers {\n    ${type} = {\n      source  = ${JSON.stringify(addr)}\n      version = ${JSON.stringify(version)}\n    }\n  }\n}\n`,
      "utf8",
    );
    const env = { TF_PLUGIN_CACHE_DIR: store.pluginCacheDir, TF_DATA_DIR: null, TF_WORKSPACE: null };
    const init = await tempDirExec(
      store,
      ["init", "-backend=false", "-input=false", "-no-color"],
      tmp,
      env,
      `downloading ${short} ${version}`,
    );
    if (init.code !== 0)
      throw new UpgradeInputError(targetInitErrorMessage(init.stderr || init.stdout, addr, version, platform));
    const dump = await tempDirExec(
      store,
      ["providers", "schema", "-json"],
      tmp,
      env,
      `reading the schema of ${short} ${version}`,
    );
    if (dump.code !== 0)
      throw new Error(
        `terraform providers schema failed for ${short} ${version} (exit ${dump.code}):\n${dump.stderr.trim()}`,
      );
    let data: SchemaDump;
    try {
      data = JSON.parse(dump.stdout) as SchemaDump;
    } catch (e) {
      throw new Error(
        `terraform providers schema -json did not return valid JSON (${e instanceof Error ? e.message : String(e)}).`,
      );
    }
    const lockText = readFileSync(join(tmp, ".terraform.lock.hcl"), "utf8");
    const lockBlock = extractLockBlock(lockText, addr);
    if (!lockBlock) throw new Error(`terraform init did not record ${addr} in the temp lock file.`);
    atomicWrite(jsonFile, dump.stdout);
    atomicWrite(lockFile, lockBlock);
    return { data, lockBlock };
  } finally {
    // Background: the temp dir may hold a provider binary that just ran, which a
    // Windows host can take a while to let go of. The startup sweep catches leftovers.
    rm(tmp, { recursive: true, force: true, maxRetries: 5 }).catch(() => {});
  }
}

const platformCache = new WeakMap<SchemaStore, Promise<string>>();

/** `terraform version -json` `.platform` (e.g. windows_amd64), once per store. */
export function terraformPlatform(store: SchemaStore, cwd: string): Promise<string> {
  let p = platformCache.get(store);
  if (!p) {
    p = (async () => {
      const r = await store.exec(["version", "-json"], { cwd });
      try {
        const platform = (JSON.parse(r.stdout) as { platform?: unknown }).platform;
        if (typeof platform === "string" && platform) return platform;
      } catch {
        // fall through
      }
      throw new Error(
        `could not read the platform from terraform version -json (exit ${r.code}): ${r.stderr.trim().slice(0, 500)}`,
      );
    })();
    p.catch(() => platformCache.delete(store));
    platformCache.set(store, p);
  }
  return p;
}

// --- Validate on a temp copy ---------------------------------------------------------------------

const MAX_COPY_BYTES = 100 * 1024 * 1024;
const MAX_COPY_FILES = 20_000;

class SkipValidate extends Error {}

const EXCLUDED_DIRS = new Set([".terraform", ".git", "node_modules", "terraform.tfstate.d"]);

function excludedFile(name: string): boolean {
  return (
    /\.tfstate$/.test(name) ||
    /\.tfstate\./.test(name) ||
    /\.tfvars$/.test(name) ||
    /\.tfvars\.json$/.test(name) ||
    /\.tfplan$/.test(name) ||
    /\.plan$/.test(name) ||
    name === "tfplan" ||
    name === "plan.out" ||
    name === "crash.log"
  );
}

/**
 * A saved plan, whatever it is named: a zip (PK\x03\x04) whose first entry is
 * Terraform's (`tfplan`, written first by planfile.Create). Plans hold plaintext
 * sensitive values. Other zips (Lambda bundles read by filebase64) are copied.
 */
function isSavedPlan(path: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    if (n < 30 || buf.readUInt32BE(0) !== 0x504b0304) return false;
    const nameLen = buf.readUInt16LE(26);
    if (30 + nameLen > n) return false;
    const name = buf.toString("utf8", 30, 30 + nameLen);
    return name === "tfplan" || name === "tfstate" || name === "tfstate-prev" || name.startsWith("tfconfig/");
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

interface CopyBudget {
  bytes: number;
  files: number;
}

function linkDir(target: string, path: string): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
  } catch (e) {
    throw new SkipValidate(
      `could not link provider packages into a temp dir (${(e as NodeJS.ErrnoException).code ?? String(e)}); validate skipped, schema comparison only`,
    );
  }
}

function copyTree(src: string, dst: string, budget: CopyBudget, excludeDirs: boolean): void {
  mkdirSync(dst, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = join(src, name);
    const to = join(dst, name);
    // Name-based exclusions come first, so a symlinked .terraform / .git / state / tfvars / plan is not linked in.
    if (excludeDirs && EXCLUDED_DIRS.has(name)) continue;
    if (excludedFile(name)) continue;
    const st = lstatSync(from);
    if (st.isSymbolicLink()) {
      // Copied as a link, never followed.
      let target: string;
      try {
        target = readlinkSync(from);
      } catch {
        continue;
      }
      let isDir = false;
      try {
        isDir = statSync(from).isDirectory();
      } catch {
        // dangling link
      }
      try {
        symlinkSync(target, to, isDir ? (process.platform === "win32" ? "junction" : "dir") : "file");
      } catch (e) {
        throw new SkipValidate(
          `could not copy the symlink ${from} into a temp dir (${(e as NodeJS.ErrnoException).code ?? String(e)}); validate skipped, schema comparison only`,
        );
      }
      continue;
    }
    if (st.isDirectory()) {
      copyTree(from, to, budget, excludeDirs);
      continue;
    }
    if (!st.isFile() || isSavedPlan(from)) continue;
    budget.files++;
    budget.bytes += st.size;
    if (budget.files > MAX_COPY_FILES || budget.bytes > MAX_COPY_BYTES) {
      throw new SkipValidate(
        "configuration is larger than 100 MB / 20000 files; validate skipped, schema comparison only",
      );
    }
    copyFileSync(from, to);
  }
}

function commonAncestor(paths: string[]): string {
  let anc = paths[0]!;
  for (const p of paths.slice(1)) {
    while (relative(anc, p).startsWith("..") || isAbsolute(relative(anc, p))) {
      const up = dirname(anc);
      if (up === anc) break;
      anc = up;
    }
  }
  return anc;
}

function parseValidate(stdout: string, stderr: string): ValidateResult {
  try {
    const parsed = JSON.parse(stdout) as ValidateResult;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    // fall through
  }
  throw new SkipValidate(`terraform validate failed to run: ${(stderr || stdout).trim().slice(0, 1000)}`);
}

export interface ValidateInput {
  store: SchemaStore;
  root: string;
  units: ModuleUnit[];
  addr: string;
  pinnedVersion: string;
  targetVersion: string;
  versions: Record<string, string>;
  platform: string;
  targetLockBlock: string;
}

/** Run validate twice on a temp copy (pinned lock, then target lock) and diff the diagnostics. */
export async function validateComparison(x: ValidateInput): Promise<{ diff: DiagDiff } | { skipped: string }> {
  const lockText = readFileSync(join(x.root, ".terraform.lock.hcl"), "utf8");
  const manifest = readManifest(x.root) ?? [];
  const modulesDir = join(x.root, ".terraform", "modules");
  const localDirs = manifest
    .filter((e) => e.Key !== "" && isLocalPath(e.Dir))
    .map((e) => resolve(x.root, e.Dir))
    .filter((d) => {
      const rel = relative(modulesDir, d);
      return rel.startsWith("..") || isAbsolute(rel);
    });
  const outside = localDirs.filter((d) => {
    const rel = relative(x.root, d);
    return rel.startsWith("..") || isAbsolute(rel);
  });
  const ancestor = commonAncestor([x.root, ...outside]);
  const base = mkdtempSync(join(tmpdir(), "tfcwd-upgrade-"));
  try {
    const tmpRoot = join(base, relative(ancestor, x.root));
    const budget: CopyBudget = { bytes: 0, files: 0 };
    try {
      copyTree(x.root, tmpRoot, budget, true);
      for (const d of outside) copyTree(d, join(base, relative(ancestor, d)), budget, true);
      if (existsSync(modulesDir)) copyTree(modulesDir, join(tmpRoot, ".terraform", "modules"), budget, false);
    } catch (e) {
      if (e instanceof SkipValidate) throw e;
      throw new SkipValidate(
        `could not copy the configuration (${(e as NodeJS.ErrnoException).code ?? String(e)}); validate skipped, schema comparison only`,
      );
    }
    // The copy recreates symlinks, so a file written into it could land on the user's own file through
    // a copied link: remove whatever is at the path first (rmSync unlinks a link, never its target).
    const writeFresh = (path: string, text: string) => {
      rmSync(path, { force: true });
      writeFileSync(path, text, "utf8");
    };

    // Provider packages as links: the user's installed ones, plus the target from the plugin cache.
    const providersDir = join(tmpRoot, ".terraform", "providers");
    for (const [addr, ver] of Object.entries(x.versions)) {
      const parts = addr.split("/");
      const src = join(x.root, ".terraform", "providers", ...parts, ver, x.platform);
      let real: string;
      try {
        real = realpathSync(src);
      } catch {
        return {
          skipped: `${x.root}/.terraform/providers has no package for ${shortAddr(addr)} ${ver}; run terraform init there. Validate skipped`,
        };
      }
      linkDir(real, join(providersDir, ...parts, ver, x.platform));
    }
    const targetPkg = join(x.store.pluginCacheDir, ...x.addr.split("/"), x.targetVersion, x.platform);
    let targetReal: string;
    try {
      targetReal = realpathSync(targetPkg);
    } catch {
      return {
        skipped: `the plugin cache has no package for ${shortAddr(x.addr)} ${x.targetVersion} at ${targetPkg} and re-downloading it failed; rerun with registry access`,
      };
    }
    linkDir(targetReal, join(providersDir, ...x.addr.split("/"), x.targetVersion, x.platform));

    const env = { TF_DATA_DIR: null, TF_WORKSPACE: null };
    const validateArgs = ["validate", "-json", "-no-color"];
    // Validate problems never fail the tool: a timeout or spawn failure degrades to schema comparison only.
    const runValidate = async () => {
      try {
        return await x.store.exec(validateArgs, { cwd: tmpRoot, env });
      } catch (e) {
        if (e instanceof TimeoutError) {
          throw new SkipValidate(
            `terraform validate timed out after ${e.timeoutMs} ms (raise TERRAFORM_CWD_MCP_TIMEOUT_MS)`,
          );
        }
        throw new SkipValidate(`terraform validate could not run: ${e instanceof Error ? e.message : String(e)}`);
      }
    };
    writeFresh(join(tmpRoot, ".terraform.lock.hcl"), lockText);
    const b = await runValidate();
    const baseline = parseValidate(b.stdout, b.stderr);

    writeFresh(join(tmpRoot, ".terraform.lock.hcl"), replaceLockBlock(lockText, x.addr, x.targetLockBlock));
    const rootUnit = x.units.find((u) => u.key === "");
    const local = rootUnit
      ? [...rootUnit.config.requiredProviders.values()].find((r) =>
          sameProvider(normalizeProviderSource(r.source ?? `hashicorp/${r.local}`), x.addr),
        )?.local
      : undefined;
    if (local) {
      writeFresh(
        join(tmpRoot, "zz_tfcwd_upgrade_override.tf"),
        `terraform {\n  required_providers {\n    ${local} = {\n      source  = ${JSON.stringify(x.addr)}\n      version = ${JSON.stringify(x.targetVersion)}\n    }\n  }\n}\n`,
      );
    }
    const t = await runValidate();
    const target = parseValidate(t.stdout, t.stderr);
    return { diff: diffDiagnostics(baseline, target) };
  } catch (e) {
    if (e instanceof SkipValidate) return { skipped: e.message };
    throw e;
  } finally {
    // The tree holds only copies and links (no fresh provider binaries); rmSync
    // removes links without following them.
    try {
      rmSync(base, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // the startup sweep catches leftovers
    }
  }
}

// --- The tool ----------------------------------------------------------------------------------------

let chain: Promise<unknown> = Promise.resolve();

/** Serialize upgrade calls in-process: Terraform's plugin cache is not safe for concurrent installs. */
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {});
  return next;
}

export interface UpgradeOptions {
  provider: string;
  version: string;
  dir?: string;
  validate: boolean;
  includeUnused: boolean;
}

/** Why `provider` did not resolve to a lock-file address: malformed, ambiguous, or not locked. */
export function unresolvedProviderMessage(input: string, versions: Record<string, string>): string {
  const s = input.trim().toLowerCase();
  const parts = s.split("/");
  const example = "provider must be <namespace>/<type>, e.g. hashicorp/local";
  if (s === "" || parts.length > 3 || parts.some((p) => p === "")) return `${example}.`;
  if (parts.length === 1) {
    const matches = Object.keys(versions).filter((a) => a.endsWith(`/${s}`));
    if (matches.length > 1) return `${input} matches ${matches.map(shortAddr).join(", ")}; ${example}.`;
  }
  return `${input} is not used by this configuration (not in .terraform.lock.hcl). tf_list_providers shows the pinned providers.`;
}

export function upgradeImpact(store: SchemaStore, opts: UpgradeOptions): Promise<string> {
  return serialized(async () => {
    const root = store.resolveRoot(opts.dir);
    assertInitialized(root);
    // Input checks first, from the lock file alone: a typo must not cost a schema dump.
    const versions = parseLockVersions(readFileSync(join(root, ".terraform.lock.hcl"), "utf8"));
    const addr = resolveProviderAddress(opts.provider, versions);
    if (!addr) return unresolvedProviderMessage(opts.provider, versions);
    const version = opts.version.trim().replace(/^v/, "");
    if (!EXACT_VERSION_RE.test(version)) return "version must be an exact version like 4.0.6, not a constraint";
    const pinnedVersion = versions[addr]!;
    if (!parseVersion(pinnedVersion))
      return `the lock file pins ${shortAddr(addr)} at "${pinnedVersion}", which is not a version this tool can compare.`;
    if (compareVersions(parseVersion(version)!, parseVersion(pinnedVersion)!) === 0) {
      return `${shortAddr(addr)} is already pinned at ${pinnedVersion}.`;
    }
    const loaded = await store.load(root);
    const platform = await terraformPlatform(store, root);
    const target = await loadTargetSchema(store, addr, version, platform, opts.validate);
    const units = await loadModules(root);
    const usage = usageFindings(
      units,
      addr,
      loaded.data.provider_schemas?.[addr],
      target.data.provider_schemas?.[addr],
      version,
    );
    const constraints = constraintReport(units, addr, version);
    const validate = opts.validate
      ? await validateComparison({
          store,
          root,
          units,
          addr,
          pinnedVersion,
          targetVersion: version,
          versions: loaded.versions,
          platform,
          targetLockBlock: target.lockBlock,
        })
      : null;
    const unused = opts.includeUnused
      ? unusedChanges(
          loaded.data.provider_schemas?.[addr],
          target.data.provider_schemas?.[addr],
          usage.usedKeys,
          splitAddr(addr).type,
        )
      : undefined;
    return renderImpact({ root, addr, pinnedVersion, targetVersion: version, usage, constraints, validate, unused });
  });
}

import type { Attr, Block, Body, HclValue, ParsedFile, Ref } from "./hcl.js";
import { moduleFiles, parseFile } from "./hcl.js";

/**
 * The module-level view of a Terraform configuration directory: variables,
 * outputs, module calls, provider requirements, resource blocks and attribute
 * references, with override files merged the way Terraform merges them.
 */

export interface VariableDecl {
  name: string;
  typeText?: string;
  hasDefault: boolean;
  default?: HclValue;
  description?: HclValue;
  sensitive: boolean;
  nullable: boolean;
  ephemeral: boolean;
  validations: number;
  file: string;
  line: number;
}

export interface OutputDecl {
  name: string;
  description?: HclValue;
  sensitive: boolean;
  ephemeral: boolean;
  file: string;
  line: number;
}

export interface ModuleCallDecl {
  name: string;
  source?: HclValue;
  version?: HclValue;
  file: string;
  line: number;
}

export interface ProviderRequirement {
  local: string;
  source?: string;
  version?: string;
  file: string;
  line: number;
}

export interface ResourceDecl {
  mode: "resource" | "data" | "ephemeral";
  type: string;
  name: string;
  /** Local provider name from the `provider` meta-argument (`rnd` for `provider = rnd.west`), if set. */
  providerLocal?: string;
  body: Body;
  /** Raw JSON body for `.tf.json` resources (attribute vs block is decided by the schema). */
  json?: Record<string, unknown>;
  file: string;
  line: number;
}

/** A `provider "<local>" { ... }` configuration block. */
export interface ProviderBlockDecl {
  local: string;
  alias?: string;
  body: Body;
  /** Raw JSON body for `.tf.json` provider blocks. */
  json?: Record<string, unknown>;
  file: string;
  line: number;
}

export interface ModuleConfig {
  dir: string;
  files: string[];
  errors: { file: string; line: number }[];
  variables: Map<string, VariableDecl>;
  outputs: Map<string, OutputDecl>;
  moduleCalls: Map<string, ModuleCallDecl>;
  requiredProviders: Map<string, ProviderRequirement>;
  /** Legacy `provider "x" { version = "..." }` constraints. */
  legacyProviderVersions: ProviderRequirement[];
  providerBlocks: ProviderBlockDecl[];
  resources: ResourceDecl[];
  refs: Ref[];
}

const lit = (v: HclValue | undefined): unknown => (v?.kind === "literal" ? v.value : undefined);
const litString = (v: HclValue | undefined): string | undefined => {
  const x = lit(v);
  return typeof x === "string" ? x : undefined;
};
const litTrue = (v: HclValue | undefined): boolean => lit(v) === true;

function attrMap(body: Body): Map<string, Attr> {
  const m = new Map<string, Attr>();
  for (const a of body.attrs) if (!m.has(a.name)) m.set(a.name, a);
  return m;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Apply one `variable` block (primary when `base` is undefined, else an override of `base`). */
function variableFrom(b: Block, base?: VariableDecl): VariableDecl {
  const a = attrMap(b.body);
  const v: VariableDecl = base
    ? { ...base }
    : {
        name: b.labels[0] ?? "",
        hasDefault: false,
        sensitive: false,
        nullable: true,
        ephemeral: false,
        validations: 0,
        file: b.file,
        line: b.line,
      };
  const type = a.get("type");
  if (type) v.typeText = type.typeText ?? (type.value.kind === "expr" ? type.value.text : String(lit(type.value)));
  if (a.has("default")) {
    v.hasDefault = true;
    v.default = a.get("default")!.value;
  }
  if (a.has("description")) v.description = a.get("description")!.value;
  if (a.has("sensitive")) v.sensitive = litTrue(a.get("sensitive")!.value);
  if (a.has("nullable")) v.nullable = lit(a.get("nullable")!.value) !== false;
  if (a.has("ephemeral")) v.ephemeral = litTrue(a.get("ephemeral")!.value);
  const validations = b.body.blocks.filter((x) => x.type === "validation").length;
  if (!base || validations > 0) v.validations = validations;
  return v;
}

function outputFrom(b: Block, base?: OutputDecl): OutputDecl {
  const a = attrMap(b.body);
  const o: OutputDecl = base
    ? { ...base }
    : { name: b.labels[0] ?? "", sensitive: false, ephemeral: false, file: b.file, line: b.line };
  if (a.has("description")) o.description = a.get("description")!.value;
  if (a.has("sensitive")) o.sensitive = litTrue(a.get("sensitive")!.value);
  if (a.has("ephemeral")) o.ephemeral = litTrue(a.get("ephemeral")!.value);
  return o;
}

function moduleCallFrom(b: Block, base?: ModuleCallDecl): ModuleCallDecl {
  const a = attrMap(b.body);
  const m: ModuleCallDecl = base ? { ...base } : { name: b.labels[0] ?? "", file: b.file, line: b.line };
  if (a.has("source")) m.source = a.get("source")!.value;
  if (a.has("version")) m.version = a.get("version")!.value;
  return m;
}

/** First identifier of a `provider = x.alias` expression. */
function providerLocalName(a: Attr | undefined): string | undefined {
  if (!a) return undefined;
  const text = a.value.kind === "expr" ? a.value.text : String(lit(a.value) ?? "");
  const m = /^([A-Za-z][A-Za-z0-9_-]*)/.exec(text.trim());
  return m?.[1];
}

/**
 * The block type a nested block contributes for override merging: `dynamic "x"`
 * generates `x` blocks, so it is keyed by its label, as Terraform does.
 */
const mergeKey = (b: Block): string => (b.type === "dynamic" ? (b.labels[0] ?? "") : b.type);

/**
 * Merge an override body into a base body: attributes replace by name, nested
 * blocks of a type (static or `dynamic "<type>"`) replace all of that type.
 */
function mergeBody(base: Body, ov: Body): Body {
  const attrs = base.attrs.filter((a) => !ov.attrs.some((o) => o.name === a.name)).concat(ov.attrs);
  const ovTypes = new Set(ov.blocks.map(mergeKey));
  const blocks = base.blocks.filter((b) => !ovTypes.has(mergeKey(b))).concat(ov.blocks);
  return { attrs, blocks };
}

function requiredProvidersFrom(b: Block, out: Map<string, ProviderRequirement>, file: string): void {
  for (const rp of b.body.blocks.filter((x) => x.type === "required_providers")) {
    for (const a of rp.body.attrs) {
      const v = lit(a.value);
      const req: ProviderRequirement = { local: a.name, file, line: a.line };
      if (typeof v === "string") {
        // Legacy shorthand: `tls = "~> 3.0"` is a version constraint for hashicorp/tls.
        req.version = v;
      } else if (isObj(v)) {
        if (typeof v.source === "string") req.source = v.source;
        if (typeof v.version === "string") req.version = v.version;
      } else if (a.value.kind === "expr") {
        // An object with a non-literal member (e.g. configuration_aliases = [x.y]): read source/version textually.
        const src = /\bsource\s*=\s*"([^"]*)"/.exec(a.value.text);
        const ver = /\bversion\s*=\s*"([^"]*)"/.exec(a.value.text);
        if (src) req.source = src[1];
        if (ver) req.version = ver[1];
      }
      out.set(a.name, req);
    }
  }
}

function emptyModule(dir: string): ModuleConfig {
  return {
    dir,
    files: [],
    errors: [],
    variables: new Map(),
    outputs: new Map(),
    moduleCalls: new Map(),
    requiredProviders: new Map(),
    legacyProviderVersions: [],
    providerBlocks: [],
    resources: [],
    refs: [],
  };
}

function applyFile(m: ModuleConfig, f: ParsedFile, override: boolean): void {
  m.files.push(f.file);
  for (const line of f.errors) m.errors.push({ file: f.file, line });
  m.refs.push(...f.refs);
  for (const b of f.body.blocks) {
    const label = b.labels[0] ?? "";
    switch (b.type) {
      case "variable": {
        const base = m.variables.get(label);
        if (override && base) m.variables.set(label, variableFrom(b, base));
        else if (!base) m.variables.set(label, variableFrom(b));
        break;
      }
      case "output": {
        const base = m.outputs.get(label);
        if (override && base) m.outputs.set(label, outputFrom(b, base));
        else if (!base) m.outputs.set(label, outputFrom(b));
        break;
      }
      case "module": {
        const base = m.moduleCalls.get(label);
        if (override && base) m.moduleCalls.set(label, moduleCallFrom(b, base));
        else if (!base) m.moduleCalls.set(label, moduleCallFrom(b));
        break;
      }
      case "terraform":
        requiredProvidersFrom(b, m.requiredProviders, f.file);
        break;
      case "provider": {
        const ver = attrMap(b.body).get("version");
        const v = litString(ver?.value);
        if (v !== undefined) m.legacyProviderVersions.push({ local: label, version: v, file: f.file, line: ver!.line });
        const alias = litString(attrMap(b.body).get("alias")?.value);
        const existing = m.providerBlocks.find((p) => p.local === label && p.alias === alias);
        if (override && existing) {
          existing.body = mergeBody(existing.body, b.body);
          if (b.json) existing.json = { ...(existing.json ?? {}), ...b.json };
        } else if (!existing) {
          const decl: ProviderBlockDecl = { local: label, body: b.body, file: b.file, line: b.line };
          if (alias !== undefined) decl.alias = alias;
          if (b.json) decl.json = b.json;
          m.providerBlocks.push(decl);
        }
        break;
      }
      case "resource":
      case "data":
      case "ephemeral": {
        if (b.labels.length < 2) break;
        const [type, name] = b.labels as [string, string];
        let json: Record<string, unknown> | undefined;
        if (f.json !== undefined) {
          const top = (f.json as Record<string, unknown>)[b.type];
          for (const item of Array.isArray(top) ? top : [top]) {
            const byType = isObj(item) ? item[type] : undefined;
            for (const t of Array.isArray(byType) ? byType : [byType]) {
              const body = isObj(t) ? t[name] : undefined;
              const first = Array.isArray(body) ? body[0] : body;
              if (isObj(first)) json = first;
            }
          }
        }
        const existing = m.resources.find((r) => r.mode === b.type && r.type === type && r.name === name);
        if (override && existing) {
          existing.body = mergeBody(existing.body, b.body);
          if (json) existing.json = { ...(existing.json ?? {}), ...json };
          const p = providerLocalName(attrMap(b.body).get("provider"));
          if (p) existing.providerLocal = p;
        } else if (!existing) {
          const decl: ResourceDecl = { mode: b.type, type, name, body: b.body, file: b.file, line: b.line };
          const p = providerLocalName(attrMap(b.body).get("provider"));
          if (p) decl.providerLocal = p;
          if (json) decl.json = json;
          m.resources.push(decl);
        }
        break;
      }
    }
  }
}

/** Read and merge every configuration file of one module directory. */
export async function loadModule(dir: string): Promise<ModuleConfig> {
  const m = emptyModule(dir);
  const { primary, override } = moduleFiles(dir);
  for (const name of primary) applyFile(m, await parseFile(dir, name), false);
  for (const name of override) applyFile(m, await parseFile(dir, name), true);
  return m;
}

/** `hashicorp/tls` -> `registry.terraform.io/hashicorp/tls`; a source with a host is lowercased and kept. */
export function normalizeProviderSource(source: string): string {
  const s = source.trim().toLowerCase();
  const parts = s.split("/");
  if (parts.length === 2) return `registry.terraform.io/${s}`;
  if (parts.length === 1) return `registry.terraform.io/hashicorp/${s}`;
  return s;
}

/** Provider source a resource uses: its `provider` meta-argument or type prefix, through required_providers. */
export function resourceProviderSource(m: ModuleConfig, r: ResourceDecl): string {
  const local = r.providerLocal ?? r.type.split("_")[0]!;
  const req = m.requiredProviders.get(local);
  return normalizeProviderSource(req?.source ?? `hashicorp/${local}`);
}

/** The default public registries, which a source without a host refers to (Terraform's, or OpenTofu's under tofu). */
const DEFAULT_HOSTS = /^(registry\.terraform\.io|registry\.opentofu\.org)\//;

/** Same provider? A host-less source means the default registry, which is OpenTofu's when the lock file says so. */
export function sameProvider(a: string, b: string): boolean {
  if (a === b) return true;
  return (
    DEFAULT_HOSTS.test(a) && DEFAULT_HOSTS.test(b) && a.replace(DEFAULT_HOSTS, "") === b.replace(DEFAULT_HOSTS, "")
  );
}

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * A reader for the parts of Terraform configuration this server needs, built
 * on the tree-sitter-hcl grammar (vendored WASM, see vendor/tree-sitter-hcl/
 * SOURCE.md). Design and the grammar quirks it works around:
 * design-capabilities.md section 3.
 *
 * It never guesses: a value that is not a literal is reported as an expression
 * (its normalized source text), and parse errors are reported with their line
 * so the caller can point at `terraform validate` as the authority.
 */

// --- Parser -------------------------------------------------------------------------

let parserPromise: Promise<Parser> | null = null;

function grammarPath(): string {
  return fileURLToPath(new URL("../vendor/tree-sitter-hcl/tree-sitter-hcl.wasm", import.meta.url));
}

/**
 * The shared parser, created lazily once per process. The grammar is read from
 * vendor/ (relative to dist/); web-tree-sitter locates its own runtime WASM.
 */
export function getParser(): Promise<Parser> {
  if (!parserPromise) {
    parserPromise = (async () => {
      await Parser.init();
      const language = await Language.load(readFileSync(grammarPath()));
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })().catch((e) => {
      parserPromise = null;
      throw new Error(
        `could not load the HCL parser (vendor/tree-sitter-hcl/tree-sitter-hcl.wasm): ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
  return parserPromise;
}

// --- Generic configuration model ---------------------------------------------------

export type HclValue = { kind: "literal"; value: unknown } | { kind: "expr"; text: string };

/** A traversal like `random_id.i[0].b64`: steps are names, `[]` for an index, `[*]` for a splat. */
export interface Ref {
  steps: string[];
  file: string;
  line: number;
}

export interface Attr {
  name: string;
  value: HclValue;
  /** Rendered type expression (only computed for attributes named `type`). */
  typeText?: string;
  /** Keys of an object-literal value, for nested-attribute paths like `settings.mode`. */
  objectKeys?: { name: string; line: number }[];
  file: string;
  line: number;
}

export interface Body {
  attrs: Attr[];
  blocks: Block[];
}

export interface Block {
  type: string;
  labels: string[];
  body: Body;
  /** Raw JSON of a top-level `.tf.json` block (attribute vs nested block is then schema-dependent). */
  json?: Record<string, unknown>;
  file: string;
  line: number;
}

export interface ParsedFile {
  file: string;
  body: Body;
  refs: Ref[];
  /** 1-based lines of parse errors (empty when the file parsed cleanly). */
  errors: number[];
  /** Original JSON for `.tf.json` files (bodies are then schema-dependent). */
  json?: unknown;
}

// --- String and template evaluation ------------------------------------------------

/** Un-escape a quoted HCL string body: `\n \r \t \" \\ \uNNNN \UNNNNNNNN`, `$${` and `%%{`. */
export function unescapeQuoted(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "\\" && i + 1 < raw.length) {
      const n = raw[i + 1]!;
      const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
      if (n in simple) {
        out += simple[n];
        i++;
        continue;
      }
      if (n === "u" || n === "U") {
        const len = n === "u" ? 4 : 8;
        const hex = raw.slice(i + 2, i + 2 + len);
        if (hex.length === len && /^[0-9A-Fa-f]+$/.test(hex)) {
          out += String.fromCodePoint(Number.parseInt(hex, 16));
          i += 1 + len;
          continue;
        }
      }
      out += c;
      continue;
    }
    if ((c === "$" || c === "%") && raw[i + 1] === c && raw[i + 2] === "{") {
      out += `${c}{`;
      i += 2;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Value of a heredoc from its raw source span (`<<EOT ... EOT` / `<<-EOT ... EOT`).
 * tree-sitter's template_literal trims the first line's indent and the trailing
 * newline, so the span is re-read here: drop the opener and closing-marker
 * lines, for `<<-` strip the minimum leading whitespace of non-blank lines, keep
 * a `\n` after every line (a CRLF file keeps its `\r`), un-escape `$${` / `%%{`.
 * Heredocs process no backslash escapes.
 */
export function heredocValue(raw: string): string {
  const lines = raw.split("\n");
  const flush = /^<<-/.test(lines[0] ?? "");
  const body = lines.slice(1, -1);
  if (flush) {
    let min = Number.POSITIVE_INFINITY;
    for (const l of body) {
      if (l.trim() === "") continue;
      min = Math.min(min, /^[ \t]*/.exec(l)![0].length);
    }
    if (!Number.isFinite(min)) min = 0;
    for (let i = 0; i < body.length; i++) {
      const l = body[i]!;
      const lead = /^[ \t]*/.exec(l)![0].length;
      body[i] = l.slice(Math.min(min, lead));
    }
  }
  return body
    .map((l) => `${l}\n`)
    .join("")
    .replace(/([$%])\1\{/g, "$1{");
}

// --- CST helpers -----------------------------------------------------------------------

function named(n: Node): Node[] {
  return n.namedChildren.filter((c): c is Node => c !== null && c.type !== "comment");
}

function hasDescendant(n: Node, types: Set<string>): boolean {
  for (const c of n.children) {
    if (!c) continue;
    if (types.has(c.type) || hasDescendant(c, types)) return true;
  }
  return false;
}

function collectComments(n: Node, out: string[]): void {
  for (const c of n.children) {
    if (!c) continue;
    if (c.type === "comment") out.push(c.text);
    else collectComments(c, out);
  }
}

/** Source text with comments removed and whitespace runs collapsed (display only). */
export function normalizedText(n: Node): string {
  let text = n.text;
  const comments: string[] = [];
  collectComments(n, comments);
  for (const c of comments) text = text.replace(c, " ");
  return text.replace(/\s+/g, " ").trim();
}

const LIVE_TEMPLATE = new Set(["template_interpolation", "template_directive"]);

function quotedContent(n: Node): string {
  const t = n.text;
  return t.length >= 2 ? t.slice(1, -1) : "";
}

function evalLiteralValue(n: Node): HclValue {
  const c = named(n)[0];
  if (!c) return { kind: "expr", text: normalizedText(n) };
  switch (c.type) {
    case "numeric_lit":
      return { kind: "literal", value: Number(c.text) };
    case "bool_lit":
      return { kind: "literal", value: c.text === "true" };
    case "null_lit":
      return { kind: "literal", value: null };
    case "string_lit":
      if (hasDescendant(c, LIVE_TEMPLATE)) return { kind: "expr", text: normalizedText(n) };
      return { kind: "literal", value: unescapeQuoted(quotedContent(c)) };
    default:
      return { kind: "expr", text: normalizedText(n) };
  }
}

/** Object key: a bare identifier or a literal string; null for a computed key. */
function evalKey(expr: Node): string | null {
  const parts = named(expr);
  if (parts.length !== 1) return null;
  const k = parts[0]!;
  if (k.type === "variable_expr") return k.text;
  if (k.type === "literal_value") {
    const v = evalLiteralValue(k);
    return v.kind === "literal" && typeof v.value === "string" ? v.value : null;
  }
  return null;
}

function objectElems(obj: Node): { key: Node; value: Node }[] {
  return named(obj)
    .filter((c) => c.type === "object_elem")
    .map((e) => {
      const exprs = named(e).filter((x) => x.type === "expression");
      return { key: exprs[0]!, value: exprs[1]! };
    })
    .filter((e) => e.key && e.value);
}

/** Evaluate an `expression` node to a literal when it is one, else report it as an expression. */
export function evalExpr(expr: Node): HclValue {
  const parts = named(expr);
  const asExpr: HclValue = { kind: "expr", text: normalizedText(expr) };
  if (parts.length !== 1) return asExpr;
  const c = parts[0]!;
  switch (c.type) {
    case "literal_value":
      return evalLiteralValue(c);
    case "template_expr": {
      const t = named(c)[0];
      if (!t || hasDescendant(t, LIVE_TEMPLATE)) return asExpr;
      if (t.type === "quoted_template") return { kind: "literal", value: unescapeQuoted(quotedContent(t)) };
      if (t.type === "heredoc_template") return { kind: "literal", value: heredocValue(t.text) };
      return asExpr;
    }
    case "collection_value": {
      const coll = named(c)[0];
      if (!coll) return asExpr;
      if (coll.type === "tuple") {
        const items: unknown[] = [];
        for (const e of named(coll).filter((x) => x.type === "expression")) {
          const v = evalExpr(e);
          if (v.kind !== "literal") return asExpr;
          items.push(v.value);
        }
        return { kind: "literal", value: items };
      }
      if (coll.type === "object") {
        const obj: Record<string, unknown> = {};
        for (const { key, value } of objectElems(coll)) {
          const k = evalKey(key);
          const v = evalExpr(value);
          if (k === null || v.kind !== "literal") return asExpr;
          obj[k] = v.value;
        }
        return { kind: "literal", value: obj };
      }
      return asExpr;
    }
    case "operation": {
      const u = named(c)[0];
      if (u?.type === "unary_operation" && u.children[0]?.type === "-") {
        const operand = named(u)[0];
        if (operand?.type === "literal_value") {
          const v = evalLiteralValue(operand);
          if (v.kind === "literal" && typeof v.value === "number") return { kind: "literal", value: -v.value };
        }
      }
      return asExpr;
    }
    default:
      return asExpr;
  }
}

/**
 * Render a type expression from the CST: `map(object({value = string, optional =
 * optional(bool, false)}))`. Collapsing the source text instead loses the
 * newline separators between object attributes.
 */
export function renderType(expr: Node): string {
  const parts = named(expr);
  if (parts.length !== 1) return normalizedText(expr);
  const c = parts[0]!;
  switch (c.type) {
    case "variable_expr":
      return c.text;
    case "function_call": {
      const name = named(c).find((x) => x.type === "identifier")?.text ?? "?";
      const argsNode = named(c).find((x) => x.type === "function_arguments");
      const args = argsNode ? named(argsNode).filter((x) => x.type === "expression") : [];
      const rendered = args.map((a, i) => {
        if (name === "optional" && i === 1) {
          const v = evalExpr(a);
          return v.kind === "literal" ? JSON.stringify(v.value) : v.text;
        }
        return renderType(a);
      });
      return `${name}(${rendered.join(", ")})`;
    }
    case "collection_value": {
      const coll = named(c)[0];
      if (coll?.type === "object") {
        const elems = objectElems(coll).map(
          ({ key, value }) => `${evalKey(key) ?? normalizedText(key)} = ${renderType(value)}`,
        );
        return `{${elems.join(", ")}}`;
      }
      if (coll?.type === "tuple") {
        return `[${named(coll)
          .filter((x) => x.type === "expression")
          .map(renderType)
          .join(", ")}]`;
      }
      return normalizedText(expr);
    }
    default:
      return normalizedText(expr);
  }
}

// --- References --------------------------------------------------------------------------

function refFromExpression(expr: Node): string[] | null {
  const parts = named(expr);
  const head = parts[0];
  if (head?.type !== "variable_expr") return null;
  const steps = [head.text];
  for (const p of parts.slice(1)) {
    if (p.type === "get_attr") {
      const id = named(p).find((x) => x.type === "identifier");
      if (!id) break;
      steps.push(id.text);
    } else if (p.type === "index") {
      steps.push("[]");
    } else if (p.type === "splat") {
      steps.push("[*]");
      const inner = named(p)[0];
      for (const g of inner ? named(inner) : []) {
        if (g.type !== "get_attr") break;
        const id = named(g).find((x) => x.type === "identifier");
        if (id) steps.push(id.text);
      }
      break;
    } else {
      break;
    }
  }
  return steps;
}

function collectRefs(n: Node, file: string, out: Ref[]): void {
  if (n.type === "expression") {
    const steps = refFromExpression(n);
    if (steps && steps.length > 1) out.push({ steps, file, line: n.startPosition.row + 1 });
  }
  for (const c of n.children) if (c) collectRefs(c, file, out);
}

// --- Bodies ------------------------------------------------------------------------------------

function blockLabel(n: Node): string {
  if (n.type === "string_lit") return unescapeQuoted(quotedContent(n));
  return n.text;
}

function parseBody(body: Node | undefined, file: string): Body {
  const out: Body = { attrs: [], blocks: [] };
  if (!body) return out;
  for (const c of named(body)) {
    if (c.type === "attribute") {
      const id = named(c).find((x) => x.type === "identifier");
      const expr = named(c).find((x) => x.type === "expression");
      if (!id || !expr) continue;
      const attr: Attr = { name: id.text, value: evalExpr(expr), file, line: c.startPosition.row + 1 };
      if (attr.name === "type") attr.typeText = renderType(expr);
      const only = named(expr);
      const coll = only.length === 1 && only[0]!.type === "collection_value" ? named(only[0]!)[0] : undefined;
      if (coll?.type === "object") {
        attr.objectKeys = objectElems(coll)
          .map(({ key }) => ({ name: evalKey(key), line: key.startPosition.row + 1 }))
          .filter((k): k is { name: string; line: number } => k.name !== null);
      }
      out.attrs.push(attr);
    } else if (c.type === "block") {
      const kids = named(c);
      const type = kids[0]?.text ?? "";
      const labels = kids
        .slice(1)
        .filter((k) => k.type === "string_lit" || k.type === "identifier")
        .map(blockLabel);
      out.blocks.push({
        type,
        labels,
        body: parseBody(
          kids.find((k) => k.type === "body"),
          file,
        ),
        file,
        line: c.startPosition.row + 1,
      });
    }
  }
  return out;
}

function errorLines(n: Node, out: number[]): void {
  if (out.length >= 5) return;
  if (n.isError || n.isMissing) {
    out.push(n.startPosition.row + 1);
    return;
  }
  for (const c of n.children) if (c?.hasError || c?.isMissing) errorLines(c, out);
}

/** Parse one native-syntax file. */
export async function parseHcl(source: string, file: string): Promise<ParsedFile> {
  const parser = await getParser();
  const tree = parser.parse(source.replace(/^﻿/, ""));
  if (!tree) throw new Error(`could not parse ${file}`);
  try {
    const root = tree.rootNode;
    const bodyNode = named(root).find((c) => c.type === "body");
    const refs: Ref[] = [];
    collectRefs(root, file, refs);
    const errors: number[] = [];
    if (root.hasError) errorLines(root, errors);
    return { file, body: parseBody(bodyNode, file), refs, errors };
  } finally {
    tree.delete();
  }
}

// --- JSON syntax (.tf.json) ---------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const JSON_REF = /\$\{([^}]*)\}/g;
const JSON_TRAVERSAL =
  /\b(data\.)?([A-Za-z_][A-Za-z0-9_-]*)\.([A-Za-z_][A-Za-z0-9_-]*)((?:\[[^\]]*\])*)\.([A-Za-z_][A-Za-z0-9_-]*)/g;

function jsonRefs(value: unknown, file: string, out: Ref[]): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(JSON_REF)) {
      for (const t of (m[1] ?? "").matchAll(JSON_TRAVERSAL)) {
        const steps = t[1] ? ["data", t[2]!, t[3]!] : [t[2]!, t[3]!];
        if (t[4]) steps.push(t[4].includes("*") ? "[*]" : "[]");
        steps.push(t[5]!);
        out.push({ steps, file, line: 0 });
      }
    }
  } else if (Array.isArray(value)) {
    for (const v of value) jsonRefs(v, file, out);
  } else if (isObj(value)) {
    for (const v of Object.values(value)) jsonRefs(v, file, out);
  }
}

function jsonValue(v: unknown): HclValue {
  if (typeof v === "string" && /\$\{|%\{/.test(v)) return { kind: "expr", text: v };
  return { kind: "literal", value: v };
}

/** Blocks nested under `variable`/`output`/`module`/... whose body keys are known not to be schema-dependent. */
const JSON_NESTED_BLOCKS: Record<string, Set<string>> = {
  variable: new Set(["validation"]),
  output: new Set(["precondition"]),
  terraform: new Set(["required_providers", "backend", "cloud"]),
};

function jsonBody(obj: Record<string, unknown>, blockType: string, file: string): Body {
  const body: Body = { attrs: [], blocks: [] };
  const nested = JSON_NESTED_BLOCKS[blockType] ?? new Set<string>();
  for (const [k, v] of Object.entries(obj)) {
    if (k === "//") continue;
    if (nested.has(k)) {
      for (const item of Array.isArray(v) ? v : [v]) {
        if (isObj(item)) body.blocks.push({ type: k, labels: [], body: jsonBody(item, k, file), file, line: 0 });
      }
      continue;
    }
    const attr: Attr = { name: k, value: jsonValue(v), file, line: 0 };
    if (k === "type" && typeof v === "string")
      attr.typeText = v
        .replace(/^\$\{([\s\S]*)\}$/, "$1")
        .replace(/\s+/g, " ")
        .trim();
    if (isObj(v)) attr.objectKeys = Object.keys(v).map((name) => ({ name, line: 0 }));
    body.attrs.push(attr);
  }
  return body;
}

/** Number of labels each top-level block type takes in JSON syntax. */
const JSON_LABELS: Record<string, number> = {
  variable: 1,
  output: 1,
  module: 1,
  provider: 1,
  resource: 2,
  data: 2,
  ephemeral: 2,
  terraform: 0,
  locals: 0,
};

/** Parse a `.tf.json` file into the same model; resource bodies keep their raw JSON in `json`. */
export function parseTfJson(source: string, file: string): ParsedFile {
  let doc: unknown;
  try {
    doc = JSON.parse(source.replace(/^﻿/, ""));
  } catch {
    return { file, body: { attrs: [], blocks: [] }, refs: [], errors: [1], json: undefined };
  }
  const body: Body = { attrs: [], blocks: [] };
  const refs: Ref[] = [];
  jsonRefs(doc, file, refs);
  if (!isObj(doc)) return { file, body, refs, errors: [1], json: doc };
  const descend = (type: string, value: unknown, labels: string[], depth: number) => {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (!isObj(item)) continue;
      if (depth === 0) {
        body.blocks.push({ type, labels, body: jsonBody(item, type, file), json: item, file, line: 0 });
      } else {
        for (const [label, inner] of Object.entries(item)) descend(type, inner, [...labels, label], depth - 1);
      }
    }
  };
  for (const [type, value] of Object.entries(doc)) {
    if (type === "//") continue;
    descend(type, value, [], JSON_LABELS[type] ?? 0);
  }
  return { file, body, refs, errors: [], json: doc };
}

// --- Module directories ----------------------------------------------------------------------

/** Terraform's config loader ignores these (configs/parser_config_dir.go IsIgnoredFile). */
export function isIgnoredFile(name: string): boolean {
  return name.startsWith(".") || name.endsWith("~") || (name.startsWith("#") && name.endsWith("#"));
}

export function isOverrideFile(name: string): boolean {
  const base = name.replace(/\.tf(\.json)?$/, "");
  return base === "override" || base.endsWith("_override");
}

/** Top-level `*.tf` / `*.tf.json` files of a module directory, primaries then overrides, each sorted by name. */
export function moduleFiles(dir: string): { primary: string[]; override: string[] } {
  const names = readdirSync(dir)
    .filter((n) => (n.endsWith(".tf") || n.endsWith(".tf.json")) && !isIgnoredFile(n))
    .filter((n) => {
      try {
        return statSync(join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
  return { primary: names.filter((n) => !isOverrideFile(n)), override: names.filter(isOverrideFile) };
}

export async function parseFile(dir: string, name: string): Promise<ParsedFile> {
  const text = readFileSync(join(dir, name), "utf8");
  return name.endsWith(".tf.json") ? parseTfJson(text, name) : parseHcl(text, name);
}

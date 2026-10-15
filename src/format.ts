import {
  KINDS,
  type Kind,
  type SchemaAttribute,
  type SchemaBlock,
  type SchemaDump,
  type TypeSchema,
} from "./schema.js";

/**
 * Pure renderers behind the four schema tools. Output format follows the Python
 * prototype line for line, so answers read the same whichever one served them.
 * Sorting is by code unit (Array#sort default), which matches Python's sorted()
 * for the ASCII names Terraform uses.
 */

const sortedEntries = <T>(rec: Record<string, T> | undefined): [string, T][] =>
  Object.entries(rec ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

export function findType(data: SchemaDump, kind: Kind, name: string): [string, TypeSchema] | null {
  for (const [addr, prov] of Object.entries(data.provider_schemas ?? {})) {
    const schema = prov[KINDS[kind]]?.[name];
    if (schema) return [addr, schema];
  }
  return null;
}

export function fmtType(t: unknown): string {
  return typeof t === "string" ? t : JSON.stringify(t);
}

function attrMode(a: SchemaAttribute): string {
  if (a.required) return "required";
  if (a.optional && a.computed) return "optional+computed";
  if (a.optional) return "optional";
  return "computed (read-only)";
}

function attrFlags(a: SchemaAttribute): string {
  return (["deprecated", "sensitive", "write_only"] as const)
    .filter((f) => a[f])
    .map((f) => ` [${f}]`)
    .join("");
}

function oneLine(desc: string | undefined, max: number): string {
  // Collapse CRLF/LF and whitespace runs: descriptions from modules checked out on
  // Windows carry \r\n, and indentation inside heredocs would otherwise survive.
  let d = (desc ?? "").replace(/\s+/g, " ").trim();
  if (max && d.length > max) d = `${d.slice(0, max)}...`;
  return d;
}

export function renderBlock(
  block: SchemaBlock,
  indent: number,
  depth: number,
  maxDepth: number,
  descLen: number,
): string[] {
  return renderAttrsAndBlocks(block.attributes, block, indent, depth, maxDepth, descLen);
}

function renderAttrsAndBlocks(
  attributes: Record<string, SchemaAttribute> | undefined,
  block: SchemaBlock | undefined,
  indent: number,
  depth: number,
  maxDepth: number,
  descLen: number,
): string[] {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];
  for (const [name, a] of sortedEntries(attributes)) {
    const typ = a.type !== undefined ? fmtType(a.type) : `nested:${a.nested_type?.nesting_mode ?? "?"}`;
    const desc = oneLine(a.description, descLen);
    lines.push(`${pad}${name}: ${typ} ${attrMode(a)}${attrFlags(a)}${desc ? ` - ${desc}` : ""}`);
    // Nested attributes (plugin protocol 6) carry their own attribute set; the
    // prototype stopped at the `nested:<mode>` line, which left an agent
    // guessing the inner names. Expanded under the same depth budget as blocks.
    if (a.type === undefined && a.nested_type?.attributes) {
      if (depth < maxDepth) {
        lines.push(
          ...renderAttrsAndBlocks(a.nested_type.attributes, undefined, indent + 1, depth + 1, maxDepth, descLen),
        );
      } else {
        lines.push(`${pad}  ... (raise max_depth to expand)`);
      }
    }
  }
  for (const [name, b] of sortedEntries(block?.block_types)) {
    const lo = b.min_items ?? 0;
    const hi = b.max_items ?? 0;
    const card = `min ${lo}${hi ? `, max ${hi}` : ""}`;
    const flags = b.block?.deprecated ? " [deprecated]" : "";
    lines.push(`${pad}${name} { block, ${b.nesting_mode}, ${card}${flags} }`);
    if (depth < maxDepth) {
      lines.push(...renderBlock(b.block ?? {}, indent + 1, depth + 1, maxDepth, descLen));
    } else {
      lines.push(`${pad}  ... (raise max_depth to expand)`);
    }
  }
  return lines;
}

export function listProviders(data: SchemaDump, versions: Record<string, string>): string {
  const rows = sortedEntries(data.provider_schemas).map(([addr, p]) => {
    const counts = (Object.entries(KINDS) as [Kind, (typeof KINDS)[Kind]][])
      .map(([k, v]) => `${Object.keys(p[v] ?? {}).length} ${k}`)
      .join(", ");
    return `${addr} ${versions[addr] ?? "?"} (${counts})`;
  });
  return rows.join("\n") || "no providers";
}

export function searchTypes(data: SchemaDump, query: string, kind: Kind, limit: number): string {
  const q = query.toLowerCase();
  const hits = Object.values(data.provider_schemas ?? {})
    .flatMap((p) => Object.keys(p[KINDS[kind]] ?? {}))
    .filter((n) => n.toLowerCase().includes(q))
    .sort();
  if (hits.length === 0) return `no ${kind} types match '${query}'`;
  const more = hits.length > limit ? `\n... ${hits.length - limit} more, narrow the query` : "";
  return hits.slice(0, limit).join("\n") + more;
}

export function getSchema(
  data: SchemaDump,
  versions: Record<string, string>,
  typeName: string,
  kind: Kind,
  maxDepth: number,
  descriptionChars: number,
): string {
  const found = findType(data, kind, typeName);
  if (!found) {
    return `${kind} '${typeName}' does not exist in the pinned providers. Use tf_search_types to find the right name.`;
  }
  const [addr, schema] = found;
  const block = schema.block ?? {};
  let head = `${kind} ${typeName} (${addr} ${versions[addr] ?? "?"})`;
  if (block.deprecated) head += " [DEPRECATED]";
  return [head, ...renderBlock(block, 1, 1, maxDepth, descriptionChars)].join("\n");
}

export function checkArguments(data: SchemaDump, typeName: string, args: string[], kind: Kind): string {
  const found = findType(data, kind, typeName);
  if (!found) return `${kind} '${typeName}' does not exist in the pinned providers.`;
  const rootBlock = found[1].block ?? {};
  return args.map((path) => `${path}: ${checkPath(rootBlock, path)}`).join("\n");
}

function checkPath(rootBlock: SchemaBlock, path: string): string {
  // `attrs` / `blocks` describe the current level. A nested attribute
  // (nested_type) is a level with attributes and no block types.
  let attrs = rootBlock.attributes ?? {};
  let blocks = rootBlock.block_types ?? {};
  const parts = path.split(".");
  let verdict: string | null = null;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    const last = i === parts.length - 1;
    if (Object.hasOwn(attrs, part)) {
      const a = attrs[part]!;
      if (!last) {
        if (a.type === undefined && a.nested_type?.attributes) {
          if (!(a.required || a.optional)) return `READ-ONLY (computed) - '${part}' cannot be set`;
          attrs = a.nested_type.attributes;
          blocks = {};
          continue;
        }
        verdict = `'${part}' is an attribute, not a block`;
      } else if (!(a.required || a.optional)) {
        verdict = "READ-ONLY (computed) - cannot be set";
      } else {
        verdict = `ok${a.deprecated ? " [deprecated]" : ""}`;
      }
      break;
    }
    if (Object.hasOwn(blocks, part)) {
      const b = blocks[part]!.block ?? {};
      attrs = b.attributes ?? {};
      blocks = b.block_types ?? {};
      if (last) verdict = `ok (block)${b.deprecated ? " [deprecated]" : ""}`;
      continue;
    }
    verdict = `UNKNOWN - '${part}' does not exist here`;
    break;
  }
  return verdict ?? "UNKNOWN - empty path";
}

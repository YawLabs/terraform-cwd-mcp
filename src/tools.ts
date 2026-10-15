import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { checkArguments, getSchema, listProviders, searchTypes } from "./format.js";
import { moduleInterface } from "./module.js";
import { detectPlanJson, isZip, type PlanInput, planShowErrorMessage, summarizePlan } from "./plan.js";
import { assertInitialized, assertLocalPath, BAD_KIND_MESSAGE, isKind, type SchemaStore } from "./schema.js";
import { listStateAddresses, noStateMessage, prepareState, renderAddresses, showResource, showState } from "./state.js";
import { upgradeImpact } from "./upgrade.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

const text = (t: string): ToolResult => ({ content: [{ type: "text", text: t }] });
const error = (t: string): ToolResult => ({ isError: true, content: [{ type: "text", text: `Error: ${t}` }] });

/** Run a tool body, turning a thrown error (uninitialized dir, terraform failure) into an MCP error result. */
async function guard(fn: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await fn();
  } catch (e) {
    return error(e instanceof Error ? e.message : String(e));
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
/** Read-only for the user's files and state, but may reach a remote backend or the provider registry. */
const READ_ONLY_OPEN = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

const PATH_MAX = 4096;
/** Plan JSON from HCP can be tens of MB; the one deliberately large string parameter. */
const PLAN_JSON_MAX = 50_000_000;
/** Largest plan JSON file read from disk (binary plans are rendered by terraform). */
const PLAN_FILE_MAX = 200 * 1024 * 1024;

const dirParam = z
  .string()
  .max(PATH_MAX)
  .optional()
  .describe(
    "Terraform root module directory (must already be initialized). Default: TERRAFORM_CWD_MCP_DIR, else the server's working directory.",
  );

// `kind` is a plain string, not z.enum: a bad value gets the same readable
// one-line answer as the prototype instead of a schema-validation error.
const kindParam = z.string().max(32).optional().default("resource").describe("resource | data | ephemeral");

export function registerTools(server: McpServer, store: SchemaStore): void {
  server.tool(
    "tf_list_providers",
    "List providers and their PINNED versions for a Terraform root module (default: cwd). " +
      "Call this first so code targets the versions actually locked in .terraform.lock.hcl, not the latest release. " +
      "Lists only the providers locked in THIS directory; it does not search the registry. For registry search, " +
      "provider docs or the latest version, use the official terraform MCP server (search_provider_docs / " +
      "get_latest_provider_version).",
    { dir: dirParam },
    READ_ONLY,
    async ({ dir }) =>
      guard(async () => {
        const { data, versions } = await store.load(dir);
        return text(listProviders(data, versions));
      }),
  );

  server.tool(
    "tf_search_types",
    "Find resource / data source / ephemeral resource type names containing `query` (e.g. 's3_bucket') " +
      "in the pinned providers. kind: resource | data | ephemeral.",
    {
      query: z.string().max(512).describe("Case-insensitive substring of the type name"),
      kind: kindParam,
      dir: dirParam,
      limit: z.number().int().min(1).max(1000).optional().default(50).describe("Max names to return (default 50)"),
    },
    READ_ONLY,
    async ({ query, kind, dir, limit }) =>
      guard(async () => {
        if (!isKind(kind)) return text(BAD_KIND_MESSAGE);
        const { data } = await store.load(dir);
        return text(searchTypes(data, query, kind, limit));
      }),
  );

  server.tool(
    "tf_get_schema",
    "Exact arguments and nested blocks for one type at the PINNED provider version. " +
      "Use BEFORE writing or editing any resource/data/ephemeral block; only arguments listed here exist. " +
      "'computed (read-only)' attributes cannot be set. kind: resource | data | ephemeral.",
    {
      type_name: z.string().max(512).describe("Full type name, e.g. aws_s3_bucket"),
      kind: kindParam,
      dir: dirParam,
      max_depth: z
        .number()
        .int()
        .min(0)
        .max(20)
        .optional()
        .default(3)
        .describe("Nested block levels to expand (default 3)"),
      description_chars: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(160)
        .describe("Truncate each description to this many characters; 0 = no limit (default 160)"),
    },
    READ_ONLY,
    async ({ type_name, kind, dir, max_depth, description_chars }) =>
      guard(async () => {
        if (!isKind(kind)) return text(BAD_KIND_MESSAGE);
        const { data, versions } = await store.load(dir);
        return text(getSchema(data, versions, type_name, kind, max_depth, description_chars));
      }),
  );

  server.tool(
    "tf_check_arguments",
    "Validate argument / nested-block paths against the PINNED schema before writing them, " +
      'e.g. ["bucket", "region", "versioning.enabled"]. Flags unknown, read-only and deprecated paths.',
    {
      type_name: z.string().max(512).describe("Full type name, e.g. aws_s3_bucket"),
      arguments: z.array(z.string().max(1024)).max(1000).describe("Dotted paths; nested blocks are separated by '.'"),
      kind: kindParam,
      dir: dirParam,
    },
    READ_ONLY,
    async ({ type_name, arguments: args, kind, dir }) =>
      guard(async () => {
        if (!isKind(kind)) return text(BAD_KIND_MESSAGE);
        const { data } = await store.load(dir);
        return text(checkArguments(data, type_name, args, kind));
      }),
  );
  registerPlanTools(server, store);
}

function readHead(file: string, n: number): Buffer {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    const read = readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

async function loadPlanFile(store: SchemaStore, planFile: string, dir: string | undefined): Promise<PlanInput> {
  const root = store.resolveRoot(dir);
  assertLocalPath(planFile);
  const file = resolve(root, planFile);
  assertLocalPath(file);
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) throw new Error("not a file");
    size = st.size;
  } catch {
    throw new Error(`${file} does not exist or is not a file.`);
  }
  if (isZip(readHead(file, 4))) {
    // Binary plan: only terraform can read it, in an initialized root with the same providers.
    assertInitialized(root);
    const r = await store.exec(["show", "-json", "-no-color", file], { cwd: root });
    if (r.code !== 0) {
      throw new Error(
        planShowErrorMessage(r.stderr, root, file) ??
          `terraform show -json failed (exit ${r.code}) rendering ${file} in ${root}:\n${r.stderr.trim().slice(0, 2048)}`,
      );
    }
    return detectPlanJson(r.stdout);
  }
  if (size > PLAN_FILE_MAX) throw new Error(`${file} is larger than ${PLAN_FILE_MAX / 1024 / 1024} MB.`);
  return detectPlanJson(readFileSync(file, "utf8"));
}

function registerPlanTools(server: McpServer, store: SchemaStore): void {
  server.tool(
    "tf_summarize_plan",
    "Summarize a saved Terraform plan: deletes and replaces first (with the attribute that forces each replace), " +
      "updates with changed paths, creates, imports, moves, forgets, drift and output changes, plus a destroy " +
      "warning that names renames needing a moved block. Pass plan_file (binary from `terraform plan -out`, rendered " +
      "with `terraform show -json` in dir, or a plan JSON file) or plan_json (e.g. from the official terraform MCP " +
      "server's get_plan_json_output(plan_id) for an HCP run; get the plan id from its get_run_details). Prints no values: sensitive paths are truncated, import IDs omitted.",
    {
      plan_file: z
        .string()
        .max(PATH_MAX)
        .optional()
        .describe(
          "Saved plan (binary from `terraform plan -out`, rendered here with `terraform show -json` in `dir`) or a plan JSON file; relative paths resolve against dir",
        ),
      plan_json: z
        .string()
        .max(PLAN_JSON_MAX)
        .optional()
        .describe("Plan JSON text, e.g. from the official terraform MCP server's get_plan_json_output"),
      dir: dirParam,
      max_per_section: z
        .number()
        .int()
        .min(1)
        .max(1000)
        .optional()
        .default(50)
        .describe("Max entries listed per section (default 50)"),
      max_paths: z
        .number()
        .int()
        .min(1)
        .max(100)
        .optional()
        .default(8)
        .describe("Changed attribute paths listed per updated resource (default 8)"),
    },
    READ_ONLY,
    async ({ plan_file, plan_json, dir, max_per_section, max_paths }) =>
      guard(async () => {
        if ((plan_file === undefined) === (plan_json === undefined))
          return text("pass exactly one of plan_file or plan_json");
        const input = plan_json !== undefined ? detectPlanJson(plan_json) : await loadPlanFile(store, plan_file!, dir);
        if (input.kind !== "plan") return text(input.kind === "refuse" ? input.message : "unexpected binary plan");
        return text(summarizePlan(input.doc, { maxPerSection: max_per_section, maxPaths: max_paths }));
      }),
  );

  server.tool(
    "tf_module_interface",
    "Variables (exact type expression, required/optional, default, sensitive/nullable/ephemeral, validation count), " +
      "outputs and module calls of a module in THIS working directory: the root, a local module directory, or an " +
      "installed module by address (module.network, resolved through .terraform/modules/modules.json, so downloaded " +
      "registry/git modules work). Module calls are checked against what is installed. For public registry modules " +
      "you have not installed, use the official terraform MCP server.",
    {
      module: z
        .string()
        .max(PATH_MAX)
        .optional()
        .describe(
          "Module to describe: omitted = the root; a module address like 'module.network' or 'module.a.module.b' (resolved through .terraform/modules/modules.json, so downloaded registry/git modules work); or a directory path relative to dir",
        ),
      dir: z
        .string()
        .max(PATH_MAX)
        .optional()
        .describe(
          "Terraform root module directory (need not be initialized for the root or a local path). Default: TERRAFORM_CWD_MCP_DIR, else the server's working directory.",
        ),
      description_chars: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(160)
        .describe("Truncate each description to this many characters; 0 = no limit (default 160)"),
    },
    READ_ONLY,
    async ({ module, dir, description_chars }) =>
      guard(async () => text(await moduleInterface(store.resolveRoot(dir), module, description_chars))),
  );

  server.tool(
    "tf_state_addresses",
    "List resource instance addresses in the current Terraform state (terraform state list), optionally filtered. " +
      "Read-only: never locks, never refreshes. With a remote backend this reads S3/GCS/HCP using the server's " +
      "credentials; a non-default workspace that does not exist is refused (reading it would create it).",
    {
      filter: z
        .string()
        .max(512)
        .optional()
        .describe("Case-sensitive substring of the address, e.g. 'module.network' or 'aws_instance.'"),
      id: z
        .string()
        .max(1024)
        .optional()
        .describe("Only the instance whose id attribute equals this (terraform state list -id)"),
      dir: dirParam,
      limit: z
        .number()
        .int()
        .min(1)
        .max(10000)
        .optional()
        .default(200)
        .describe("Max addresses to return (default 200)"),
    },
    READ_ONLY_OPEN,
    async ({ filter, id, dir, limit }) =>
      guard(async () => {
        const ctx = await prepareState(store.exec, store.resolveRoot(dir));
        const addresses = await listStateAddresses(store.exec, ctx, id);
        return text(renderAddresses(addresses, ctx, filter, id, limit));
      }),
  );

  server.tool(
    "tf_show_resource",
    "Show one resource instance's attribute values from the current Terraform state (terraform show -json). " +
      "Read-only: never locks, never refreshes. Sensitive values are redacted: Terraform's own markers, plus values " +
      "equal to a marked one, secret-like names and secret-shaped strings; a footer says what was hidden and why.",
    {
      address: z
        .string()
        .max(1024)
        .describe(
          'Exact resource instance address from tf_state_addresses, e.g. aws_instance.web[0] or module.db.aws_db_instance.this["primary"]',
        ),
      dir: dirParam,
      include_null: z.boolean().optional().default(false).describe("Also list attributes whose value is null"),
      max_value_chars: z
        .number()
        .int()
        .min(0)
        .optional()
        .default(200)
        .describe("Truncate each value; 0 = no limit (default 200)"),
    },
    READ_ONLY_OPEN,
    async ({ address, dir, include_null, max_value_chars }) =>
      guard(async () => {
        const ctx = await prepareState(store.exec, store.resolveRoot(dir));
        const doc = await showState(store.exec, ctx);
        if (!doc) return text(noStateMessage(ctx.workspace.name, ctx.backend));
        return text(showResource(doc, address.trim(), { includeNull: include_null, maxValueChars: max_value_chars }));
      }),
  );

  server.tool(
    "tf_upgrade_impact",
    "What breaks if a pinned provider is upgraded (or downgraded) to an exact version: compares the pinned schema " +
      "with the target's for the arguments, nested blocks and attribute reads this configuration uses (root and " +
      "installed modules), checks version constraints, and confirms with terraform validate on a temp copy. " +
      "Downloads the target provider from the registry into a cache (temp dirs only; never touches dir). " +
      "For the latest version number or upgrade guides, use the official terraform MCP server.",
    {
      provider: z
        .string()
        .max(256)
        .describe("Provider address as pinned, e.g. hashicorp/aws or registry.terraform.io/hashicorp/aws"),
      version: z.string().max(64).describe("Exact target version, e.g. 6.0.0 (not a constraint)"),
      dir: dirParam,
      validate: z
        .boolean()
        .optional()
        .default(true)
        .describe("Confirm with terraform validate on a temp copy (offline once the target is downloaded)"),
      include_unused: z
        .boolean()
        .optional()
        .default(false)
        .describe("Also list target-version changes to types/arguments this configuration does not use"),
    },
    READ_ONLY_OPEN,
    async ({ provider, version, dir, validate, include_unused }) =>
      guard(async () =>
        text(await upgradeImpact(store, { provider, version, dir, validate, includeUnused: include_unused })),
      ),
  );
}

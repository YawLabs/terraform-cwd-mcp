import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SchemaStore, type StoreOptions } from "./schema.js";
import { registerTools } from "./tools.js";
import { sweepStaleTempDirs } from "./upgrade.js";

export * from "./config.js";
export * from "./constraints.js";
export * from "./format.js";
export * from "./hcl.js";
export * from "./module.js";
export * from "./plan.js";
export * from "./redact.js";
export * from "./schema.js";
export * from "./state.js";
export * from "./upgrade.js";

export const version: string = createRequire(import.meta.url)("../package.json").version;

export const INSTRUCTIONS =
  "What is actually true in THIS Terraform working directory: the provider schemas pinned in .terraform.lock.hcl " +
  "(source: `terraform providers schema -json`), the saved plan, the current state and the local/installed modules. " +
  "Before writing or editing a resource/data/ephemeral block, call tf_get_schema (or tf_check_arguments on the paths " +
  "you plan to write): only listed arguments exist, and 'computed (read-only)' ones cannot be set; tf_list_providers " +
  "and tf_search_types find versions and type names. tf_summarize_plan summarizes a saved plan (plan_file) or plan " +
  "JSON (plan_json), destroys first; it prints no values. tf_module_interface lists a module's variables, outputs and " +
  "module calls (root, local path, or an installed module address). tf_state_addresses and tf_show_resource read the " +
  "current state without locking or refreshing, with sensitive values redacted. tf_upgrade_impact shows what breaks if " +
  "a pinned provider moves to an exact version (schema diff of the arguments this configuration uses, confirmed by " +
  "terraform validate on a temp copy; it downloads the target provider into a cache, never into the root). " +
  "Authority split: this server wins on argument validity for the pinned version and on this directory's plan, state " +
  "and modules; HashiCorp's official terraform MCP server wins on usage docs, latest versions, public registry modules " +
  "and HCP/TFE runs (fetch an HCP run's plan there, summarize it here via plan_json). The root module must already " +
  "be initialized (`terraform init`); this server never runs init in it.";

export function createTerraformCwdServer(opts: StoreOptions = {}): McpServer {
  const server = new McpServer({ name: "terraform-cwd-mcp", version }, { instructions: INSTRUCTIONS });
  registerTools(server, new SchemaStore(opts));
  return server;
}

export async function startServer(): Promise<void> {
  // Leftover tf_upgrade_impact temp dirs from a crashed run (older than 1 h), in the background.
  setImmediate(() => sweepStaleTempDirs());
  const server = createTerraformCwdServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

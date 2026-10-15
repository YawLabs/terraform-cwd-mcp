import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTerraformCwdServer, version } from "../server.js";
import { cleanupTempDirs, FIXTURE_TEXT, fixtureRoot, tempDir } from "./helpers.js";

const pkg = createRequire(import.meta.url)("../../package.json") as { version: string };

/**
 * Real server + real MCP client over an in-memory transport, so zod shapes are
 * converted and validated by the SDK exactly as on a live launch.
 */
async function connect(opts: Parameters<typeof createTerraformCwdServer>[0]) {
  const server = createTerraformCwdServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "terraform-cwd-mcp-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = res.content as { type: string; text: string }[];
  return content.map((c) => c.text).join("\n");
}

describe("server", () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    cleanupTempDirs();
  });

  it("reports the package.json version", () => {
    expect(version).toBe(pkg.version);
  });

  it("serves exactly the nine read-only tools with honest openWorld hints", async () => {
    client = await connect({ cacheDir: tempDir(), runner: vi.fn(async () => FIXTURE_TEXT) });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "tf_check_arguments",
      "tf_get_schema",
      "tf_list_providers",
      "tf_module_interface",
      "tf_search_types",
      "tf_show_resource",
      "tf_state_addresses",
      "tf_summarize_plan",
      "tf_upgrade_impact",
    ]);
    const openWorld = new Set(["tf_state_addresses", "tf_show_resource", "tf_upgrade_impact"]);
    for (const t of tools) {
      expect(t.description).toBeTruthy();
      expect(t.annotations?.readOnlyHint).toBe(true);
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.annotations?.idempotentHint).toBe(true);
      expect(t.annotations?.openWorldHint, t.name).toBe(openWorld.has(t.name));
      expect(t.inputSchema.properties).toHaveProperty("dir");
      // Every string parameter is length-capped (compliance: security-oversized-input).
      for (const [name, p] of Object.entries(t.inputSchema.properties ?? {}) as [
        string,
        { type?: string; maxLength?: number },
      ][]) {
        if (p.type === "string") expect(p.maxLength, `${t.name}.${name}`).toBeGreaterThan(0);
      }
    }
    const instructions = client.getInstructions() ?? "";
    expect(instructions).toMatch(/never runs init/);
    for (const t of tools) expect(instructions).toContain(t.name);
    expect(instructions).toMatch(/official .*terraform MCP server/i);
    // Tools that overlap with the official server say where the boundary is.
    for (const name of ["tf_list_providers", "tf_module_interface", "tf_upgrade_impact", "tf_summarize_plan"]) {
      expect(tools.find((t) => t.name === name)?.description, name).toMatch(/official terraform MCP server/);
    }
    expect(tools.find((t) => t.name === "tf_list_providers")?.description).toMatch(/does not search the registry/);
  });

  it("answers every tool against the default dir", async () => {
    const root = fixtureRoot();
    const runner = vi.fn(async () => FIXTURE_TEXT);
    client = await connect({ cacheDir: tempDir(), defaultDir: root, runner });

    expect(textOf(await client.callTool({ name: "tf_list_providers", arguments: {} }))).toBe(
      [
        "registry.terraform.io/hashicorp/random 3.9.1 (10 resource, 0 data, 2 ephemeral)",
        "registry.terraform.io/hashicorp/tls 4.4.1 (4 resource, 2 data, 2 ephemeral)",
      ].join("\n"),
    );
    expect(textOf(await client.callTool({ name: "tf_search_types", arguments: { query: "key", kind: "data" } }))).toBe(
      "tls_public_key",
    );
    expect(
      textOf(
        await client.callTool({ name: "tf_get_schema", arguments: { type_name: "random_pet", description_chars: 0 } }),
      ),
    ).toBe(
      [
        "resource random_pet (registry.terraform.io/hashicorp/random 3.9.1)",
        "  id: string computed (read-only) - The random pet name.",
        '  keepers: ["map","string"] optional - Arbitrary map of values that, when changed, will trigger recreation of resource. See [the main provider documentation](../index.html) for more information.',
        "  length: number optional+computed - The length (in words) of the pet name. Defaults to 2",
        "  prefix: string optional - A string to prefix the name with.",
        '  separator: string optional+computed - The character to separate words in the pet name. Defaults to "-"',
      ].join("\n"),
    );
    expect(
      textOf(
        await client.callTool({
          name: "tf_check_arguments",
          arguments: { type_name: "random_pet", arguments: ["length", "id", "nope"] },
        }),
      ),
    ).toBe("length: ok\nid: READ-ONLY (computed) - cannot be set\nnope: UNKNOWN - 'nope' does not exist here");
    // All four calls shared one schema dump.
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("takes an explicit dir per call", async () => {
    const root = fixtureRoot();
    client = await connect({ cacheDir: tempDir(), defaultDir: tempDir(), runner: vi.fn(async () => FIXTURE_TEXT) });
    const res = await client.callTool({ name: "tf_search_types", arguments: { query: "uuid7", dir: root } });
    expect(res.isError).toBeFalsy();
    expect(textOf(res)).toBe("random_uuid7");
  });

  it("answers a bad kind on every kind-taking tool without loading anything", async () => {
    const runner = vi.fn(async () => FIXTURE_TEXT);
    client = await connect({ cacheDir: tempDir(), defaultDir: fixtureRoot(), runner });
    const calls = [
      { name: "tf_search_types", arguments: { query: "x", kind: "module" } },
      { name: "tf_get_schema", arguments: { type_name: "x", kind: "module" } },
      { name: "tf_check_arguments", arguments: { type_name: "x", arguments: ["a"], kind: "module" } },
    ];
    for (const call of calls) {
      expect(textOf(await client.callTool(call))).toBe("kind must be one of ['resource', 'data', 'ephemeral']");
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("returns an actionable error for an uninitialized dir and never runs terraform", async () => {
    const runner = vi.fn(async () => FIXTURE_TEXT);
    client = await connect({ cacheDir: tempDir(), runner });
    const root = fixtureRoot({ initialized: false });
    for (const call of [
      { name: "tf_list_providers", arguments: { dir: root } },
      { name: "tf_search_types", arguments: { query: "x", dir: root } },
      { name: "tf_get_schema", arguments: { type_name: "x", dir: root } },
      { name: "tf_check_arguments", arguments: { type_name: "x", arguments: ["a"], dir: root } },
    ]) {
      const res = await client.callTool(call);
      expect(res.isError).toBe(true);
      expect(textOf(res)).toMatch(/^Error: .*is not initialized.*terraform init -backend=false/);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("surfaces a terraform failure as a tool error", async () => {
    client = await connect({
      cacheDir: tempDir(),
      defaultDir: fixtureRoot(),
      runner: vi.fn(async () => {
        throw new Error("terraform providers schema failed (exit 1):\nInconsistent dependency lock file");
      }),
    });
    const res = await client.callTool({ name: "tf_list_providers", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toContain("Inconsistent dependency lock file");
  });
});

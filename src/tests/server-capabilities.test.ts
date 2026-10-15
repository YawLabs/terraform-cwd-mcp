import { copyFileSync, mkdirSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecOptions, RunResult } from "../schema.js";
import { createTerraformCwdServer } from "../server.js";
import { cleanupTempDirs, FIXTURE_TEXT, FIXTURES, fixtureCopy, fixtureRoot, readFixture, tempDir } from "./helpers.js";

/**
 * The plan / module / state / upgrade tools end to end: real McpServer + Client
 * over InMemoryTransport, terraform replaced by an injected exec.
 */

async function connect(opts: Parameters<typeof createTerraformCwdServer>[0]) {
  const server = createTerraformCwdServer(opts);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "terraform-cwd-mcp-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(res: Awaited<ReturnType<Client["callTool"]>>): string {
  return (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");
}

type Exec = (args: string[], opts: ExecOptions) => RunResult;
const mkExec = (h: Exec) => vi.fn(async (args: string[], opts: ExecOptions): Promise<RunResult> => h(args, opts));
const okRun = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const failRun = (stderr: string): RunResult => ({ code: 1, stdout: "", stderr });

describe("server: plan, module, state and upgrade tools", () => {
  let client: Client | undefined;
  afterEach(async () => {
    await client?.close();
    client = undefined;
    cleanupTempDirs();
  });

  it("tf_summarize_plan: plan_json, plan JSON file, binary plan, refusals and the one-of rule", async () => {
    const root = fixtureRoot();
    const exec = mkExec((args) => (args[0] === "show" ? okRun(readFixture("plan/plan.json")) : failRun("unexpected")));
    client = await connect({ cacheDir: tempDir(), defaultDir: root, runner: vi.fn(async () => FIXTURE_TEXT), exec });
    const call = (args: Record<string, unknown>) => client!.callTool({ name: "tf_summarize_plan", arguments: args });

    const fromJson = await call({ plan_json: readFixture("plan/plan.json") });
    expect(fromJson.isError).toBeFalsy();
    expect(textOf(fromJson)).toMatch(/^plan \(terraform 1\.15\.7, format 1\.2\): applyable, complete\n/);
    expect(textOf(fromJson)).not.toMatch(/FIXTURE-SECRET|p-9hUg/);

    copyFileSync(join(FIXTURES, "plan", "plan.json"), join(root, "plan.json"));
    expect(textOf(await call({ plan_file: "plan.json" }))).toBe(textOf(fromJson));
    expect(exec).not.toHaveBeenCalled();

    writeFileSync(join(root, "tfplan"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
    expect(textOf(await call({ plan_file: "tfplan", max_per_section: 1 }))).toContain(
      "REPLACE (5)\n  -/+ local_sensitive_file.sf delete-then-create; forced by: content [sensitive]\n  ... 4 more",
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0]).toEqual(["show", "-json", "-no-color", join(root, "tfplan")]);
    expect(exec.mock.calls[0]![1].cwd).toBe(root);

    expect(textOf(await call({}))).toBe("pass exactly one of plan_file or plan_json");
    expect(textOf(await call({ plan_file: "x", plan_json: "{}" }))).toBe("pass exactly one of plan_file or plan_json");
    const state = await call({ plan_json: readFixture("state/state.json") });
    expect(state.isError).toBeFalsy();
    expect(textOf(state)).toBe("this is a state file, not a plan. Use tf_show_resource / tf_state_addresses.");
    const missing = await call({ plan_file: "nope.tfplan" });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/^Error: .*nope\.tfplan does not exist or is not a file\./);
    const unc = await call({ plan_file: "\\\\host\\share\\tfplan" });
    expect(unc.isError).toBe(true);
    expect(textOf(unc)).toMatch(/UNC or device path/);

    // A directory is not a plan file.
    mkdirSync(join(root, "plans"));
    const dirRes = await call({ plan_file: "plans" });
    expect(dirRes.isError).toBe(true);
    expect(textOf(dirRes)).toMatch(/plans does not exist or is not a file\./);

    // A non-zip file over the 200 MB cap is refused before it is read (sparse: no real 200 MB write).
    const big = join(root, "big.json");
    writeFileSync(big, "{");
    truncateSync(big, 200 * 1024 * 1024 + 1);
    const bigRes = await call({ plan_file: "big.json" });
    expect(bigRes.isError).toBe(true);
    expect(textOf(bigRes)).toMatch(/big\.json is larger than 200 MB\.$/);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("tf_summarize_plan: a binary plan needs an initialized root; show failures map to messages", async () => {
    const root = fixtureRoot({ initialized: false });
    writeFileSync(join(root, "tfplan"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const exec = mkExec(() => failRun("Error: Failed to load plugin schemas"));
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    const res = await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file: "tfplan" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/is not initialized/);
    expect(exec).not.toHaveBeenCalled();
    mkdirSync(join(root, ".terraform"));
    writeFileSync(join(root, ".terraform.lock.hcl"), "");
    const res2 = await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file: "tfplan" } });
    expect(res2.isError).toBe(true);
    expect(textOf(res2)).toMatch(
      /^Error: could not render the plan here: the providers it was made with are not installed/,
    );
  });

  it("tf_module_interface: root by default, module address, unknown address error, no subprocess", async () => {
    const root = fixtureCopy("modroot");
    const exec = mkExec(() => failRun("must not run"));
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    const rootOut = textOf(await client.callTool({ name: "tf_module_interface", arguments: {} }));
    expect(rootOut.split("\n")[0]).toBe("module (root): 1 variables, 4 outputs, 2 module calls");
    expect(rootOut).not.toContain("FIXTURE-SECRET");
    const label = textOf(
      await client.callTool({
        name: "tf_module_interface",
        arguments: { module: "module.label", description_chars: 0 },
      }),
    );
    expect(label.split("\n")[0]).toBe(
      "module .terraform/modules/label (module.label): 18 variables, 19 outputs, 0 module calls",
    );
    const bad = await client.callTool({ name: "tf_module_interface", arguments: { module: "module.nope" } });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/^Error: module\.nope is not in \.terraform\/modules\/modules\.json/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("tf_state_addresses and tf_show_resource read state through terraform, redacted", async () => {
    const root = fixtureRoot();
    const exec = mkExec((args) => {
      if (args[0] === "state") return okRun("random_integer.n[0]\nrandom_integer.n[1]\nterraform_data.cfg\n");
      if (args[0] === "show") return okRun(readFixture("state/state.json"));
      return failRun("unexpected");
    });
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    expect(textOf(await client.callTool({ name: "tf_state_addresses", arguments: { filter: "random_integer" } }))).toBe(
      "2 addresses matching 'random_integer' in workspace 'default' (backend local)\nrandom_integer.n[0]\nrandom_integer.n[1]",
    );
    const shown = textOf(
      await client.callTool({ name: "tf_show_resource", arguments: { address: "terraform_data.cfg" } }),
    );
    expect(shown).toContain("  output.pw = (redacted: contains a sensitive value)");
    expect(shown).not.toContain("FIXTURE-SECRET");
    for (const c of exec.mock.calls) {
      expect(c[1].cwd).toBe(root);
      expect(["state", "show"]).toContain(c[0][0]);
    }
  });

  it("state tools: no state is a fact, a lock is an error, an uninitialized root never runs terraform", async () => {
    const root = fixtureRoot();
    let mode = "none";
    const exec = mkExec((args) => {
      if (mode === "none") {
        return args[0] === "show"
          ? okRun(readFixture("state/no-state.json"))
          : failRun(readFixture("state/stderr/state-list-no-state.txt"));
      }
      return failRun(readFixture("state/stderr/state-locked-windows.txt"));
    });
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    const noState = "No state in workspace 'default' (backend local): nothing has been applied yet.";
    for (const call of [
      { name: "tf_state_addresses", arguments: {} },
      { name: "tf_show_resource", arguments: { address: "a.b" } },
    ]) {
      const res = await client.callTool(call);
      expect(res.isError).toBeFalsy();
      expect(textOf(res)).toBe(noState);
    }
    mode = "locked";
    const locked = await client.callTool({ name: "tf_state_addresses", arguments: {} });
    expect(locked.isError).toBe(true);
    expect(textOf(locked)).toMatch(/^Error: The state file is locked by another Terraform process/);
    exec.mockClear();
    const res = await client.callTool({
      name: "tf_show_resource",
      arguments: { address: "a.b", dir: fixtureRoot({ initialized: false }) },
    });
    expect(res.isError).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });

  it("tf_upgrade_impact: input facts as text, and an uninitialized root as an error", async () => {
    const root = fixtureRoot();
    const exec = mkExec(() => failRun("must not run"));
    const runner = vi.fn(async () => FIXTURE_TEXT);
    client = await connect({ cacheDir: tempDir(), defaultDir: root, runner, exec });
    const call = (args: Record<string, unknown>) => client!.callTool({ name: "tf_upgrade_impact", arguments: args });
    expect(textOf(await call({ provider: "hashicorp/random", version: "3.9.1" }))).toBe(
      "hashicorp/random is already pinned at 3.9.1.",
    );
    expect(textOf(await call({ provider: "hashicorp/random", version: ">= 4.0" }))).toBe(
      "version must be an exact version like 4.0.6, not a constraint",
    );
    expect(textOf(await call({ provider: "hashicorp/aws", version: "6.0.0" }))).toMatch(
      /^hashicorp\/aws is not used by this configuration/,
    );
    expect(exec).not.toHaveBeenCalled();
    // Input facts come from the lock file alone: no schema dump either.
    expect(runner).not.toHaveBeenCalled();
    const bad = await call({
      provider: "hashicorp/random",
      version: "4.0.0",
      dir: fixtureRoot({ initialized: false }),
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toMatch(/is not initialized/);
  });

  it("tf_upgrade_impact: a failed download is an error result", async () => {
    const root = fixtureRoot();
    const exec = mkExec((args) =>
      args[0] === "version"
        ? okRun('{"platform":"test_arch"}')
        : failRun("Error: no available releases match the given constraints 9.9.9"),
    );
    client = await connect({
      cacheDir: tempDir(),
      defaultDir: root,
      runner: vi.fn(async () => FIXTURE_TEXT),
      exec,
      pluginCacheDir: tempDir(),
    });
    const res = await client.callTool({
      name: "tf_upgrade_impact",
      arguments: { provider: "hashicorp/tls", version: "9.9.9" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(
      "Error: hashicorp/tls 9.9.9 does not exist in the registry. The official terraform MCP server's provider lookup lists valid versions.",
    );
    const init = exec.mock.calls.find((c) => c[0][0] === "init")!;
    expect(init[1].cwd).not.toBe(root);
  });

  it("rejects an oversized string parameter at the schema layer", async () => {
    client = await connect({ cacheDir: tempDir(), defaultDir: fixtureRoot() });
    const res = await client.callTool({ name: "tf_show_resource", arguments: { address: "a".repeat(2000) } });
    expect(res.isError).toBe(true);
  });
});

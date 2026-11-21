import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { moduleFiles } from "../hcl.js";
import { detectPlanJson, type PlanDoc, summarizePlan, UNVERIFIED_PLAN_NOTE } from "../plan.js";
import { Redactor } from "../redact.js";
import {
  backendType,
  createTerraformExec,
  parseAllowedDirs,
  type RunResult,
  SchemaStore,
  type TerraformExec,
  terraformEnv,
} from "../schema.js";
import { createTerraformCwdServer } from "../server.js";
import {
  addressesForDisplay,
  noStateMessage,
  renderAddresses,
  renderResource,
  type StateDoc,
  showResource,
  stateErrorMessage,
  workspaceMissingMessage,
} from "../state.js";
import { loadModules, UPGRADE_DISABLED_MESSAGE, validateComparison } from "../upgrade.js";
import { cleanupTempDirs, FIXTURE_TEXT, fixtureRoot, readFixture, tempDir } from "./helpers.js";

/**
 * Regression tests for the security review. Everything runs in temp dirs with
 * fake credentials; "terraform" is a local Node script that only records what it
 * was given. Nothing here contacts a network.
 */

const FAKE_CREDENTIAL = "FAKE-CREDENTIAL-VALUE";
const ABS_BIN = resolve("/bin");

async function connect(opts: Parameters<typeof createTerraformCwdServer>[0]) {
  const server = createTerraformCwdServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "security-test", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}

const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) =>
  (res.content as { text: string }[]).map((c) => c.text).join("\n");

interface Recorded {
  args: string[];
  cwd: string;
  credential: string | null;
  github: string | null;
}

/**
 * A terraform stand-in playing a planted provider: each run appends the credential
 * it can see to a log next to the script, then answers like terraform would.
 */
function plantedTerraform(): { exec: TerraformExec; runs: () => Recorded[] } {
  const dir = tempDir("tfcwd-fake-tf-");
  const script = join(dir, "terraform.mjs");
  const log = join(dir, "log.jsonl");
  writeFileSync(
    script,
    `import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, cwd: process.cwd(), credential: process.env.AWS_SECRET_ACCESS_KEY ?? null, github: process.env.GITHUB_TOKEN ?? null }) + "\\n");
const state = { format_version: "1.0", values: { root_module: { resources: [{ address: "a_b.c", mode: "managed", type: "a_b", name: "c", values: { v: "1" } }] } } };
if (args[0] === "providers") console.log(JSON.stringify({ format_version: "1.0", provider_schemas: {} }));
else if (args[0] === "show") console.log(JSON.stringify(state));
else if (args[0] === "state" && args[1] === "pull") console.log(JSON.stringify({ version: 4 }));
else if (args[0] === "state") console.log("a_b.c");
`,
  );
  const real = createTerraformExec({ binary: process.execPath });
  return {
    exec: (args, opts) => real([script, ...args], opts),
    runs: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l) as Recorded)
        : [],
  };
}

function withBackend(root: string, type: string): string {
  writeFileSync(join(root, ".terraform", "terraform.tfstate"), JSON.stringify({ version: 3, backend: { type } }));
  return root;
}

let client: Client | undefined;
afterEach(async () => {
  await client?.close();
  client = undefined;
  vi.unstubAllEnvs();
  cleanupTempDirs();
});

describe("terraform child environment", () => {
  const base = {
    PATH: ABS_BIN,
    Path: ABS_BIN,
    HOME: "/home/u",
    AWS_SECRET_ACCESS_KEY: FAKE_CREDENTIAL,
    GITHUB_TOKEN: FAKE_CREDENTIAL,
    TF_VAR_db_password: FAKE_CREDENTIAL,
    TF_TOKEN_app_terraform_io: FAKE_CREDENTIAL,
    HTTPS_PROXY: "http://user:pw@127.0.0.1:1",
    ASDF_DATA_DIR: "/asdf",
  };

  it("scrubbed keeps only what terraform needs to start", () => {
    const env = terraformEnv({}, "scrubbed", base);
    expect(Object.values(env)).not.toContain(FAKE_CREDENTIAL);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.ASDF_DATA_DIR).toBeUndefined();
    expect(env).toMatchObject({ PATH: ABS_BIN, Path: ABS_BIN, HOME: "/home/u", CHECKPOINT_DISABLE: "1" });
  });

  it("scrubbing is the default", () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    expect(terraformEnv().AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("download adds the proxy and host-scoped registry tokens, not cloud credentials", () => {
    const env = terraformEnv({}, "download", base);
    expect(env.TF_TOKEN_app_terraform_io).toBe(FAKE_CREDENTIAL);
    expect(env.HTTPS_PROXY).toBe(base.HTTPS_PROXY);
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.TF_VAR_db_password).toBeUndefined();
  });

  it("TERRAFORM_CWD_MCP_PASS_ENV adds named variables", () => {
    const env = terraformEnv({}, "scrubbed", { ...base, TERRAFORM_CWD_MCP_PASS_ENV: "asdf_data_dir, OTHER" });
    expect(env.ASDF_DATA_DIR).toBe("/asdf");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });
});

describe("a planted provider sees no credential", () => {
  it("tf_list_providers on a local-backend root", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    const root = fixtureRoot();
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    expect((await client.callTool({ name: "tf_list_providers", arguments: {} })).isError).toBeFalsy();
    expect(runs().map((r) => [r.args[0], r.credential])).toEqual([["providers", null]]);
  });

  it("tf_list_providers on a remote-backend root runs outside the root, without the backend", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    const root = withBackend(fixtureRoot(), "s3");
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    expect((await client.callTool({ name: "tf_list_providers", arguments: {} })).isError).toBeFalsy();
    const [run] = runs();
    expect(run!.credential).toBeNull();
    expect(run!.cwd).not.toBe(root);
    expect(existsSync(run!.cwd)).toBe(false);
  });

  it("falls back to the isolated dump when the root's backend was never initialized", async () => {
    const root = fixtureRoot();
    const calls: string[] = [];
    const exec: TerraformExec = async (_args, { cwd }) => {
      calls.push(cwd);
      return cwd === root
        ? { code: 1, stdout: "", stderr: "Error: Backend initialization\nrequired, please run terraform init" }
        : { code: 0, stdout: FIXTURE_TEXT, stderr: "" };
    };
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    expect((await client.callTool({ name: "tf_list_providers", arguments: {} })).isError).toBeFalsy();
    expect(calls).toHaveLength(2);
    expect(calls[1]).not.toBe(root);
  });

  it("refuses an isolated dump for a lock file with a crafted provider address", async () => {
    const root = withBackend(fixtureRoot(), "s3");
    writeFileSync(join(root, ".terraform.lock.hcl"), 'provider "a/b/${file("x")}" {\n  version = "1.0.0"\n}\n');
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    const res = await client.callTool({ name: "tf_list_providers", arguments: {} });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/invalid provider address/);
    expect(runs()).toEqual([]);
  });

  it("tf_show_resource and tf_state_addresses on the local backend", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    const root = fixtureRoot();
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    expect(textOf(await client.callTool({ name: "tf_show_resource", arguments: { address: "a_b.c" } }))).toContain(
      'v = "1"',
    );
    await client.callTool({ name: "tf_state_addresses", arguments: {} });
    expect(runs().length).toBeGreaterThan(1);
    for (const r of runs()) expect(r.credential).toBeNull();
  });

  it("remote backend, opted in: only state commands get credentials; show reads a pulled copy without them", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    vi.stubEnv("TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS", "1");
    const root = withBackend(fixtureRoot(), "s3");
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    expect(textOf(await client.callTool({ name: "tf_show_resource", arguments: { address: "a_b.c" } }))).toContain(
      'v = "1"',
    );
    await client.callTool({ name: "tf_state_addresses", arguments: {} });
    const [pull, show, list] = runs();
    expect(pull).toMatchObject({ args: ["state", "pull"], credential: FAKE_CREDENTIAL });
    expect(show!.args.slice(0, 3)).toEqual(["show", "-json", "-no-color"]);
    expect(show!.credential).toBeNull();
    expect(existsSync(show!.args[3]!)).toBe(false);
    expect(list).toMatchObject({ args: ["state", "list", "-no-color"], credential: FAKE_CREDENTIAL });
  });

  it("a binary plan is rendered without credentials", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    const root = fixtureRoot();
    writeFileSync(join(root, "tfplan"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file: "tfplan" } });
    expect(runs().map((r) => [r.args[0], r.credential])).toEqual([["show", null]]);
  });
});

describe("dir confinement", () => {
  const store = (defaultDir: string, allowedDirs: string[] = []) =>
    new SchemaStore({ cacheDir: tempDir(), defaultDir, allowedDirs, runner: vi.fn(async () => FIXTURE_TEXT) });

  it("refuses a root outside the server's directory, naming the fix, and runs nothing", async () => {
    const outside = fixtureRoot();
    const runner = vi.fn(async () => FIXTURE_TEXT);
    client = await connect({ cacheDir: tempDir(), defaultDir: tempDir(), allowedDirs: [], runner });
    for (const call of [
      { name: "tf_list_providers", arguments: { dir: outside } },
      { name: "tf_state_addresses", arguments: { dir: outside } },
      { name: "tf_show_resource", arguments: { address: "a.b", dir: outside } },
      { name: "tf_module_interface", arguments: { dir: outside } },
      { name: "tf_summarize_plan", arguments: { plan_file: "p.json", dir: outside } },
      { name: "tf_upgrade_impact", arguments: { provider: "hashicorp/tls", version: "9.0.0", dir: outside } },
    ]) {
      const res = await client.callTool(call);
      expect(res.isError, call.name).toBe(true);
      expect(textOf(res), call.name).toMatch(/outside the directories .*TERRAFORM_CWD_MCP_ALLOWED_DIRS/);
    }
    expect(runner).not.toHaveBeenCalled();
  });

  it("accepts the directory and its children; a relative dir resolves against it", () => {
    const base = tempDir();
    mkdirSync(join(base, "envs", "prod"), { recursive: true });
    const s = store(base);
    expect(s.resolveRoot()).toBe(base);
    expect(s.resolveRoot("envs/prod")).toBe(join(base, "envs", "prod"));
    expect(s.resolveRoot(join(base, "envs"))).toBe(join(base, "envs"));
  });

  it("refuses traversal, a sibling sharing the prefix, and a link leading out", () => {
    const parent = tempDir();
    const base = join(parent, "repo");
    const sibling = join(parent, "repo-evil");
    mkdirSync(base);
    mkdirSync(sibling);
    symlinkSync(sibling, join(base, "link"), process.platform === "win32" ? "junction" : "dir");
    const s = store(base);
    for (const dir of ["..", "../repo-evil", sibling, join(base, "link"), join(base, "link", "missing")]) {
      expect(() => s.resolveRoot(dir), dir).toThrow(/outside the directories/);
    }
  });

  it("the operator's list extends the boundary", () => {
    const other = tempDir();
    expect(store(tempDir(), [other]).resolveRoot(other)).toBe(other);
  });

  it("parses TERRAFORM_CWD_MCP_ALLOWED_DIRS like PATH and rejects UNC entries", () => {
    const [a, b] = [tempDir(), tempDir()];
    expect(parseAllowedDirs({ TERRAFORM_CWD_MCP_ALLOWED_DIRS: `${a}${delimiter} ${b} ${delimiter}` })).toEqual([a, b]);
    expect(parseAllowedDirs({})).toEqual([]);
    expect(() => parseAllowedDirs({ TERRAFORM_CWD_MCP_ALLOWED_DIRS: "\\\\host\\share" })).toThrow(/UNC/);
  });

  it("tf_module_interface cannot read a module path outside the boundary", async () => {
    const parent = tempDir();
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "main.tf"), 'variable "leak" {}\n');
    client = await connect({ cacheDir: tempDir(), defaultDir: root, allowedDirs: [] });
    const res = await client.callTool({ name: "tf_module_interface", arguments: { module: "../outside" } });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toContain("leak");
  });
});

describe("tf_upgrade_impact opt-in", () => {
  it("is refused by default before anything runs, and says how to enable it", async () => {
    vi.stubEnv("TERRAFORM_CWD_MCP_ALLOW_UPGRADE", "");
    const root = fixtureRoot();
    const exec = vi.fn<TerraformExec>();
    const runner = vi.fn(async () => FIXTURE_TEXT);
    const pluginCacheDir = join(tempDir(), "plugins");
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec, runner, pluginCacheDir });
    const res = await client.callTool({
      name: "tf_upgrade_impact",
      arguments: { provider: "hashicorp/tls", version: "9.9.9" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toBe(`Error: ${UPGRADE_DISABLED_MESSAGE}`);
    expect(textOf(res)).toContain("TERRAFORM_CWD_MCP_ALLOW_UPGRADE=1");
    expect(exec).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(existsSync(pluginCacheDir)).toBe(false);
  });

  it("only the exact value 1 enables it", () => {
    for (const [value, allowed] of [
      ["1", true],
      ["true", false],
      ["0", false],
    ] as const) {
      vi.stubEnv("TERRAFORM_CWD_MCP_ALLOW_UPGRADE", value);
      expect(new SchemaStore({ cacheDir: tempDir() }).allowUpgrade, value).toBe(allowed);
    }
  });
});

describe("tool annotations and descriptions", () => {
  it("only the tool that starts no subprocess claims to be read-only", async () => {
    client = await connect({ cacheDir: tempDir(), runner: vi.fn(async () => FIXTURE_TEXT) });
    const { tools } = await client.listTools();
    expect(tools.filter((t) => t.annotations?.readOnlyHint !== false).map((t) => t.name)).toEqual([
      "tf_module_interface",
    ]);
    for (const t of tools) {
      if (t.name === "tf_module_interface") {
        expect(t.annotations?.openWorldHint).toBe(false);
        continue;
      }
      expect(t.annotations?.openWorldHint, t.name).toBe(true);
      expect(t.description, t.name).toMatch(/Executes code/);
    }
    const byName = (n: string) => tools.find((t) => t.name === n)?.description;
    expect(byName("tf_upgrade_impact")).toContain("TERRAFORM_CWD_MCP_ALLOW_UPGRADE=1");
    expect(byName("tf_show_resource")).toMatch(/best effort/);
    expect(byName("tf_summarize_plan")).toMatch(/unverified caller input/);
  });
});

describe("forged and malformed plans", () => {
  const OPTS = { maxPerSection: 50, maxPaths: 8 };
  const change = (address: string, actions: unknown, extra: object = {}) => ({
    address,
    mode: "managed",
    type: "a_b",
    name: "c",
    ...extra,
    change: { actions, before: null, after: null },
  });
  const doc = (changes: unknown, extra: object = {}) => ({
    format_version: "1.2",
    terraform_version: "1.15.7",
    resource_changes: changes,
    ...extra,
  });
  const refusal = (value: unknown): string => {
    const r = detectPlanJson(JSON.stringify(value));
    expect(r.kind).toBe("refuse");
    return (r as { message: string }).message;
  };
  const summary = (value: object) => {
    const r = detectPlanJson(JSON.stringify(value));
    if (r.kind !== "plan") throw new Error(JSON.stringify(r));
    return summarizePlan(r.doc, OPTS);
  };

  it.each<[string, unknown, RegExp]>([
    ["planned_values only", { planned_values: {} }, /no format_version/],
    ["unknown major version", doc([], { format_version: "2.0" }), /not a supported 1\.x version/],
    ["numeric version", doc([], { format_version: 1 }), /no format_version/],
    ["no resource_changes", { format_version: "1.2", planned_values: {} }, /no resource_changes/],
    ["resource_changes not an array", doc({}), /resource_changes is not an array/],
    ["entry not an object", doc(["x"]), /resource_changes\[0\] is not an object/],
    ["entry without address", doc([{ change: { actions: ["delete"] } }]), /resource_changes\[0\] has no address/],
    ["entry without change", doc([{ address: "a.b" }]), /has no change object/],
    ["actions not a list", doc([change("a.b", "delete")]), /no valid change\.actions/],
    ["empty actions", doc([change("a.b", [])]), /no valid change\.actions/],
    ["non-string action", doc([change("a.b", [1])]), /no valid change\.actions/],
    ["bad drift", doc([], { resource_drift: [{}] }), /resource_drift\[0\] has no address/],
    ["bad outputs", doc([], { output_changes: { x: {} } }), /output_changes has an entry/],
    ["bad deferred", doc([], { deferred_changes: {} }), /deferred_changes is not an array/],
  ])("refuses %s", (_name, value, message) => {
    expect(refusal(value)).toMatch(message);
  });

  it("the forged empty plan is refused by the tool instead of reported as no changes", async () => {
    client = await connect({ cacheDir: tempDir(), defaultDir: tempDir() });
    const res = await client.callTool({
      name: "tf_summarize_plan",
      arguments: { plan_json: '{"planned_values":{}}' },
    });
    expect(textOf(res)).toMatch(/^not a usable Terraform plan/);
    expect(textOf(res)).not.toContain("no changes");
  });

  it("terraform's own output with no resource_changes is taken at its word; the same text as input is not", () => {
    const text = JSON.stringify({ format_version: "1.2", planned_values: { root_module: {} }, applyable: false });
    const r = detectPlanJson(text, { renderedByTerraform: true });
    expect(r.kind).toBe("plan");
    expect(summarizePlan((r as { doc: PlanDoc }).doc, OPTS)).toContain("no changes");
    expect(detectPlanJson(text).kind).toBe("refuse");
  });

  it("marks plan JSON as unverified, and not a plan terraform rendered", async () => {
    const root = fixtureRoot();
    writeFileSync(join(root, "tfplan"), Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const plan = readFixture("plan/plan.json");
    const exec: TerraformExec = async () => ({ code: 0, stdout: plan, stderr: "" });
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    const fromJson = textOf(await client.callTool({ name: "tf_summarize_plan", arguments: { plan_json: plan } }));
    const fromBinary = textOf(await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file: "tfplan" } }));
    expect(fromJson).toBe(`${fromBinary}\n${UNVERIFIED_PLAN_NOTE}`);
  });

  it("never hides a delete behind mode data", () => {
    const out = summary(doc([change("aws_db_instance.prod", ["delete"], { mode: "data" })]));
    expect(out).toContain("DELETE (1)\n  - aws_db_instance.prod");
    expect(out).toContain("1 to destroy");
    expect(out).toContain("WARNING: 1 object(s) will be destroyed");
  });

  it("lists a real removed data source without counting it as a destroy", () => {
    for (const address of ["data.a_b.c", 'module.m["x"].data.a_b.c']) {
      const out = summary(doc([change(address, ["delete"], { mode: "data" })]));
      expect(out).toContain(`DATA SOURCE REMOVED (1)\n  - ${address} (dropped from state, nothing is destroyed)`);
      expect(out).toContain("0 to destroy");
      expect(out).not.toContain("WARNING");
    }
  });

  it("still shows a data-mode replace", () => {
    expect(summary(doc([change("data.a_b.c", ["delete", "create"], { mode: "data" })]))).toContain("REPLACE (1)");
  });

  it("escapes control characters so a value cannot forge output lines", () => {
    const forged = "a_b.c\nWARNING: 0 object(s) will be destroyed\u2028no changes\u202e\u001b[2J";
    const out = summary(
      doc([change(forged, ["update"]), change("x_y.z", ["delete"], { action_reason: "r\nDELETE (0)" })], {
        terraform_version: "1\nno changes",
        output_changes: { "o\nno changes": { actions: ["create"] } },
        resource_drift: [change("d\nfake", ["weird\nline"])],
        deferred_changes: [{ reason: "why\nfake", resource_change: change("e\nfake", ["create"]) }],
      }),
    );
    const lines = out.split("\n");
    expect(lines.some((l) => l.startsWith("WARNING: 0"))).toBe(false);
    expect(lines).not.toContain("no changes");
    expect(lines).not.toContain("DELETE (0)");
    expect(lines).not.toContain("fake");
    expect(out).toContain("a_b.c\\u000aWARNING");
    // Nothing unescaped is left besides the line breaks the renderer emits itself.
    expect(out.replace(/\n/g, "")).not.toMatch(/\p{Cc}|\u2028|\u202e/u);
  });

  it("escapes attribute paths too", () => {
    const value = doc([
      {
        address: "a_b.c",
        change: { actions: ["update"], before: { "k\u2028x": 1 }, after: { "k\u2028x": 2 } },
      },
    ]);
    expect(summary(value)).toContain('["k\\u2028x"]');
  });

  it("redacts sensitive instance keys in addresses", () => {
    const secret = "FIXTURE-SECRET-instance-key";
    const out = summary(
      doc([
        {
          address: `a_b.c["${secret}"]`,
          change: {
            actions: ["create"],
            before: null,
            after: { v: secret },
            after_sensitive: { v: true },
          },
        },
        change('a_b.d["ghp_0123456789abcdefghij0123"]', ["create"]),
      ]),
    );
    expect(out).not.toContain(secret);
    expect(out).not.toContain("ghp_");
    expect(out).toContain('+ a_b.c["(redacted key)"]');
    expect(out).toContain('+ a_b.d["(redacted key)"]');
  });
});

describe("plan_file confinement and parse errors", () => {
  it("refuses a plan outside dir, without reading it", async () => {
    const parent = tempDir();
    const root = join(parent, "root");
    mkdirSync(root);
    const outside = join(parent, "secret.txt");
    writeFileSync(outside, "FIXTURE-SECRET-file-content");
    client = await connect({ cacheDir: tempDir(), defaultDir: parent, allowedDirs: [] });
    for (const plan_file of [outside, "../secret.txt"]) {
      const res = await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file, dir: root } });
      expect(res.isError, plan_file).toBe(true);
      expect(textOf(res), plan_file).toMatch(/plan_file .* is outside dir .*Move or copy the plan/);
      expect(textOf(res), plan_file).not.toContain("FIXTURE-SECRET");
    }
  });

  it("refuses a link inside dir that leads out", async () => {
    const parent = tempDir();
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "plan.json"), "FIXTURE-SECRET-file-content");
    symlinkSync(outside, join(root, "plans"), process.platform === "win32" ? "junction" : "dir");
    client = await connect({ cacheDir: tempDir(), defaultDir: parent, allowedDirs: [] });
    const res = await client.callTool({
      name: "tf_summarize_plan",
      arguments: { plan_file: "plans/plan.json", dir: root },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/is outside dir/);
  });

  it("a parse error does not quote the input", async () => {
    const root = tempDir();
    writeFileSync(join(root, "notes.txt"), "FIXTURE-SECRET-file-content");
    client = await connect({ cacheDir: tempDir(), defaultDir: root });
    const out = textOf(await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file: "notes.txt" } }));
    expect(out).toMatch(/^not a Terraform plan: the input is not JSON\./);
    expect(out).not.toContain("FIXTURE");
    const inline = detectPlanJson("FIXTURE-SECRET{");
    expect(JSON.stringify(inline)).not.toContain("FIXTURE");
  });

  it("a bookmark's run id is printed only when it looks like one", () => {
    const message = (run_id: unknown) =>
      (detectPlanJson(JSON.stringify({ remote_plan_format: 1, run_id })) as { message: string }).message;
    expect(message("run-abc123")).toContain("bookmark for run run-abc123;");
    expect(message("FIXTURE-SECRET\nline")).not.toContain("FIXTURE");
  });
});

describe("backend credentials are an operator opt-in", () => {
  const OPT_IN = "TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS";
  const base = {
    HOME: "/home/u",
    AWS_SECRET_ACCESS_KEY: FAKE_CREDENTIAL,
    GOOGLE_CREDENTIALS: FAKE_CREDENTIAL,
    TF_HTTP_PASSWORD: FAKE_CREDENTIAL,
    TF_TOKEN_app_terraform_io: FAKE_CREDENTIAL,
    TF_VAR_db_password: FAKE_CREDENTIAL,
    GITHUB_TOKEN: FAKE_CREDENTIAL,
    HTTPS_PROXY: "http://127.0.0.1:1",
  };

  it("without it the backend profile passes no credential at all", () => {
    for (const backend of ["s3", "gcs", "http", "remote"]) {
      const env = terraformEnv({}, "backend", base, backend);
      expect(Object.values(env), backend).not.toContain(FAKE_CREDENTIAL);
      expect(env.HTTPS_PROXY, backend).toBeUndefined();
    }
  });

  it("only the exact value 1 opts in", () => {
    const env = terraformEnv({}, "backend", { ...base, [OPT_IN]: "true" }, "s3");
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it.each([
    ["s3", "AWS_SECRET_ACCESS_KEY"],
    ["gcs", "GOOGLE_CREDENTIALS"],
    ["http", "TF_HTTP_PASSWORD"],
    ["cloud", "TF_TOKEN_app_terraform_io"],
  ])("with it, %s gets its own variables and nothing else", (backend, name) => {
    const env = terraformEnv({}, "backend", { ...base, [OPT_IN]: "1" }, backend);
    const passed = Object.entries(env).filter(([, v]) => v === FAKE_CREDENTIAL);
    expect(passed.map(([k]) => k)).toEqual([name]);
    expect(env.HTTPS_PROXY).toBe(base.HTTPS_PROXY);
  });

  it("a backend type this server does not know gets no credential", () => {
    for (const backend of ["unknown", "constructor", "__proto__"]) {
      const env = terraformEnv({}, "backend", { ...base, [OPT_IN]: "1" }, backend);
      expect(Object.values(env), backend).not.toContain(FAKE_CREDENTIAL);
    }
  });

  it("a state command run from a root with a remote backend sees no credential by default", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    vi.stubEnv("GITHUB_TOKEN", FAKE_CREDENTIAL);
    vi.stubEnv(OPT_IN, "");
    const root = withBackend(fixtureRoot(), "s3");
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    await client.callTool({ name: "tf_state_addresses", arguments: {} });
    await client.callTool({ name: "tf_show_resource", arguments: { address: "a_b.c" } });
    expect(runs().length).toBeGreaterThan(2);
    for (const r of runs()) expect([r.args[0], r.credential, r.github]).toEqual([r.args[0], null, null]);
  });

  it("opted in, backend commands see that backend's variables, never an unrelated one, and show sees neither", async () => {
    vi.stubEnv("AWS_SECRET_ACCESS_KEY", FAKE_CREDENTIAL);
    vi.stubEnv("GITHUB_TOKEN", FAKE_CREDENTIAL);
    vi.stubEnv(OPT_IN, "1");
    const root = withBackend(fixtureRoot(), "s3");
    const { exec, runs } = plantedTerraform();
    client = await connect({ cacheDir: tempDir(), defaultDir: root, exec });
    await client.callTool({ name: "tf_show_resource", arguments: { address: "a_b.c" } });
    const [pull, show] = runs();
    expect(pull).toMatchObject({ args: ["state", "pull"], credential: FAKE_CREDENTIAL, github: null });
    expect(show).toMatchObject({ credential: null, github: null });
  });

  it("a credential failure says how to opt in, and stops saying so once opted in", () => {
    const stderr = "Error: No valid credential sources found";
    const off = stateErrorMessage("state list", 1, stderr, "/r", "s3", {});
    expect(off).toMatch(/credentials are missing or expired/);
    expect(off).toContain(`${OPT_IN}=1`);
    expect(stateErrorMessage("state list", 1, stderr, "/r", "s3", { [OPT_IN]: "1" })).not.toContain(OPT_IN);
    expect(stateErrorMessage("state list", 1, "Error: Missing region", "/r", "s3", {})).toContain(OPT_IN);
    expect(stateErrorMessage("state list", 1, "boom", "/r", "local", {})).not.toContain(OPT_IN);
  });

  it("a forged backend type cannot inject output lines", () => {
    const root = withBackend(fixtureRoot(), "s3\nFORGED-LINE");
    expect(backendType(root)).toBe("unknown");
  });
});

describe("a binary planted in the root is not run", () => {
  it("PATH entries that resolve against cwd are dropped", () => {
    const abs = resolve("bin-dir");
    const env = terraformEnv({}, "scrubbed", { PATH: ["", ".", "rel/bin", abs].join(delimiter) });
    expect(env.PATH).toBe(abs);
  });

  it.runIf(process.platform === "win32")("a bare terraform resolves on PATH, not in cwd", async () => {
    const root = tempDir("tfcwd-planted-");
    const bin = tempDir("tfcwd-real-bin-");
    const place = (dest: string) => {
      try {
        linkSync(process.execPath, dest);
      } catch {
        copyFileSync(process.execPath, dest);
      }
    };
    place(join(root, "terraform.exe"));
    place(join(bin, "terraform.exe"));
    // Either copy of node runs this file for `terraform state ...`; it reports which copy that was.
    writeFileSync(join(root, "state"), 'console.log(process.execPath + "|" + (process.env.GITHUB_TOKEN ?? "none"));\n');
    vi.stubEnv("NoDefaultCurrentDirectoryInExePath", undefined as unknown as string);
    vi.stubEnv("PATH", bin);
    vi.stubEnv("GITHUB_TOKEN", FAKE_CREDENTIAL);
    const r = await createTerraformExec({ binary: "terraform" })(["state", "list"], { cwd: root });
    expect(r.code, r.stderr).toBe(0);
    const [ran, token] = r.stdout.trim().split("|");
    expect(realpathSync(ran!).toLowerCase()).toBe(realpathSync(join(bin, "terraform.exe")).toLowerCase());
    expect(token).toBe("none");
  });
});

describe("module manifest entries stay inside the boundary for tf_upgrade_impact", () => {
  function plantedManifest() {
    const parent = tempDir();
    const root = join(parent, "root");
    const outside = join(parent, "shared");
    cpSync(fixtureRoot(), root, { recursive: true });
    mkdirSync(outside);
    writeFileSync(
      join(outside, "main.tf"),
      'terraform {\n  required_providers {\n    tls = { source = "hashicorp/tls", version = "< 1.0.0" }\n  }\n}\n',
    );
    mkdirSync(join(root, ".terraform", "modules"), { recursive: true });
    writeFileSync(
      join(root, ".terraform", "modules", "modules.json"),
      JSON.stringify({
        Modules: [
          { Key: "", Source: "", Dir: "." },
          { Key: "planted", Source: "../shared", Dir: "../shared" },
        ],
      }),
    );
    return { root, outside };
  }

  it("the tool refuses before running or downloading anything", async () => {
    const { root } = plantedManifest();
    const exec = vi.fn<TerraformExec>();
    const runner = vi.fn(async () => FIXTURE_TEXT);
    const pluginCacheDir = join(tempDir(), "plugins");
    client = await connect({
      cacheDir: tempDir(),
      defaultDir: root,
      allowedDirs: [],
      allowUpgrade: true,
      exec,
      runner,
      pluginCacheDir,
    });
    const res = await client.callTool({
      name: "tf_upgrade_impact",
      arguments: { provider: "hashicorp/tls", version: "9.9.9" },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).toMatch(/shared is outside the directories this server may use/);
    expect(textOf(res)).toContain("TERRAFORM_CWD_MCP_ALLOWED_DIRS");
    expect(textOf(res)).not.toContain("< 1.0.0");
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(pluginCacheDir)).toBe(false);
  });

  it("the validate step refuses too, before copying the directory", async () => {
    const { root } = plantedManifest();
    const store = new SchemaStore({
      cacheDir: tempDir(),
      defaultDir: root,
      allowedDirs: [],
      exec: vi.fn<TerraformExec>(),
    });
    await expect(
      validateComparison({
        store,
        root,
        units: [],
        addr: "registry.terraform.io/hashicorp/tls",
        pinnedVersion: "4.4.1",
        targetVersion: "9.9.9",
        versions: {},
        platform: "windows_amd64",
        targetLockBlock: "",
      }),
    ).rejects.toThrow(/outside the directories this server may use/);
  });

  it("an entry the operator allowed still loads", async () => {
    const { root, outside } = plantedManifest();
    const store = new SchemaStore({ cacheDir: tempDir(), defaultDir: root, allowedDirs: [outside] });
    const units = await loadModules(root, (d) => store.assertAllowedDir(d));
    expect(units.map((u) => u.key)).toEqual(["", "planted"]);
  });
});

describe("secrets in state keys and addresses", () => {
  const MARKED = "marked-secret-value-1";
  const AWS_ID = "AKIAIOSFODNN7EXAMPLE";
  const OPTS = { includeNull: false, maxValueChars: 200 };
  const resource = (address: string, values: Record<string, unknown>, sensitive_values: object = {}) => ({
    address,
    mode: "managed",
    type: "terraform_data",
    name: "x",
    provider_name: "terraform.io/builtin/terraform",
    values,
    sensitive_values,
  });
  const doc = (): StateDoc => ({
    values: {
      root_module: {
        resources: [
          resource(`terraform_data.marked["${MARKED}"]`, { input: MARKED }, { input: true }),
          resource(`terraform_data.aws["${AWS_ID}"]`, { input: "plain" }),
          resource("terraform_data.maps", { input: { [AWS_ID]: "under-aws", [MARKED]: "under-marked", ok: "fine" } }),
        ],
      },
    },
  });
  const ctx = {
    root: "/r",
    workspace: { name: "default", source: "default" as const },
    backend: "local",
    env: {} as NodeJS.ProcessEnv,
  };
  const rawState = (names: string[] = ["maps"]) =>
    JSON.stringify({ version: 4, resources: names.map((name) => ({ mode: "managed", type: "terraform_data", name })) });
  const execFor = (show: () => RunResult, pulled = rawState()): TerraformExec =>
    vi.fn<TerraformExec>(async (args) => {
      if (args[0] === "state") return { code: 0, stdout: pulled, stderr: "" };
      return show();
    });
  const okShow = () => ({ code: 0, stdout: JSON.stringify(doc()), stderr: "" });

  it("tf_show_resource hides map keys that are marked values or secret-shaped", () => {
    const out = showResource(doc(), "terraform_data.maps", OPTS);
    expect(out).not.toContain(AWS_ID);
    expect(out).not.toContain(MARKED);
    expect(out).toContain('input["(redacted key)"] = "under-aws"');
    expect(out).toContain('input.ok = "fine"');
    expect(out).toMatch(/redacted: .*1 by value, 1 by shape/);
  });

  it("its header and instance list hide them too", () => {
    const head = showResource(doc(), `terraform_data.aws["${AWS_ID}"]`, OPTS).split("\n")[0]!;
    expect(head).toMatch(/^terraform_data\.aws\["\(redacted key\)"\] \(/);
    const list = showResource(doc(), "terraform_data.marked", OPTS);
    expect(list).toBe('terraform_data.marked has 1 instances; pass one: terraform_data.marked["(redacted key)"]');
  });

  it("an address printed with a hidden key still selects the instance", () => {
    const out = showResource(doc(), 'terraform_data.aws["(redacted key)"]', OPTS);
    expect(out).toContain('input = "plain"');
  });

  it("tf_state_addresses hides the same keys, and its filter cannot probe them", async () => {
    const listed = [`terraform_data.aws["${AWS_ID}"]`, `terraform_data.marked["${MARKED}"]`, "terraform_data.maps"];
    const { addresses, note } = await addressesForDisplay(execFor(okShow), ctx, listed);
    expect(addresses).toEqual([
      'terraform_data.aws["(redacted key)"]',
      'terraform_data.marked["(redacted key)"]',
      "terraform_data.maps",
    ]);
    expect(note).toBeUndefined();
    expect(renderAddresses(addresses, ctx, "marked-secret", undefined, 10)).toBe("no addresses match 'marked-secret'");
  });

  it("starts no plugin when no address has a string key", async () => {
    const show = vi.fn(okShow);
    await addressesForDisplay(execFor(show), ctx, ["terraform_data.maps", "a_b.c[0]"]);
    expect(show).not.toHaveBeenCalled();
  });

  it("hides every string key, and says so, when terraform show cannot run", async () => {
    const exec = execFor(() => ({ code: 1, stdout: "", stderr: "Error: Required plugins are not installed" }));
    const { addresses, note } = await addressesForDisplay(exec, ctx, ['a_b.c["harmless"]', "a_b.d[1]"]);
    expect(addresses).toEqual(['a_b.c["(redacted key)"]', "a_b.d[1]"]);
    expect(note).toMatch(/every string instance key is hidden.*terraform init/);
    expect(renderAddresses(addresses, ctx, undefined, undefined, 10, note).split("\n").at(-1)).toBe(note);
  });

  it("refuses a listing with a forged line, without printing any of it", async () => {
    await expect(addressesForDisplay(execFor(okShow), ctx, ["a_b.c", "FORGED-STATE-LINE"])).rejects.toThrow(
      /not a valid Terraform name.*none are printed/,
    );
  });

  it("refuses when raw state shows lines were forged, even if each looks like an address", async () => {
    const forged = rawState(["x\n  FORGED\nno_such.resource"]);
    const err = await addressesForDisplay(execFor(okShow, forged), ctx, ["a_b.x", "no_such.resource"]).catch(
      (e: Error) => e.message,
    );
    expect(err).toMatch(/terraform\.tfstate\.backup/);
    expect(err).not.toContain("FORGED");
  });

  it("control characters in a state document's names cannot forge tf_show_resource lines", () => {
    const res = { ...resource("a_b.c", { "k FORGED": "v" }), type: "t\nFORGED", provider_name: "p\nFORGED" };
    const out = renderResource(res, new Set(), OPTS);
    for (const line of out.split("\n")) expect(line.startsWith("FORGED")).toBe(false);
    expect(out).not.toContain(" ");
  });
});

describe("Redactor.address decodes Terraform's key escapes", () => {
  it.each([
    ["a newline", "line1secret\nline2secret", String.raw`line1secret\nline2secret`],
    ["a tab", "tab\tsecret", String.raw`tab\tsecret`],
    ["a quote", 'quo"te-secret', String.raw`quo\"te-secret`],
    ["a backslash", "back\\slash-secret", String.raw`back\\slash-secret`],
    ["a template", "x${secret}y", "x$${secret}y"],
    ["a directive", "x%{secret}y", "x%%{secret}y"],
    ["a unicode escape", "non\u0001printable", String.raw`non\u0001printable`],
    ["a long unicode escape", "wide\u{e0001}key", String.raw`wide\U000e0001key`],
  ])("hides a marked key holding %s", (_name, secret, written) => {
    const shown = new Redactor(new Set([secret])).address(`a_b.c["${written}"]`);
    expect(shown).toBe('a_b.c["(redacted key)"]');
  });

  it("leaves other keys as written", () => {
    expect(new Redactor(new Set(["other-value"])).address(String.raw`a_b.c["plain\nkey"]`)).toBe(
      String.raw`a_b.c["plain\nkey"]`,
    );
  });
});

describe("plan JSON without resource_changes", () => {
  const empty = (extra: object = {}) =>
    JSON.stringify({
      format_version: "1.2",
      terraform_version: "1.15.7",
      planned_values: { root_module: {} },
      configuration: { root_module: {} },
      applyable: false,
      complete: true,
      errored: false,
      ...extra,
    });
  const resources = { root_module: { resources: [{ address: "a_b.c" }] } };

  it("accepts Terraform's output for a plan with no resource instances", () => {
    const r = detectPlanJson(empty());
    expect(r.kind).toBe("plan");
    expect(summarizePlan((r as { doc: PlanDoc }).doc, { maxPerSection: 50, maxPaths: 8 })).toContain("no changes");
  });

  it.each([
    ["no configuration", { configuration: undefined }],
    ["planned resources", { planned_values: resources }],
    [
      "planned resources in a child module",
      { planned_values: { root_module: { child_modules: [resources.root_module] } } },
    ],
    ["resources in prior state", { prior_state: { values: resources } }],
    ["drift", { resource_drift: [{ address: "a_b.c", change: { actions: ["update"] } }] }],
  ])("refuses a document with %s", (_name, extra) => {
    const r = detectPlanJson(empty(extra));
    expect(r.kind).toBe("refuse");
    expect((r as { message: string }).message).toMatch(/no resource_changes.*not a consistently empty plan/);
  });
});

describe("regression: forgery, containment and output-forging fixes", () => {
  const OPTS = { maxPerSection: 50, maxPaths: 8 };
  const plan = (extra: object) =>
    JSON.stringify({
      format_version: "1.2",
      terraform_version: "1.15.7",
      configuration: { root_module: {} },
      planned_values: { root_module: {} },
      applyable: false,
      complete: true,
      errored: false,
      ...extra,
    });

  it("refuses resource_changes: [] while another section still names a resource", () => {
    // The consistency check used to run only when the key was ABSENT, so writing [] got
    // a clean "no changes" with the deleted resource still visible in planned_values.
    const r = detectPlanJson(
      plan({
        planned_values: { root_module: { resources: [{ address: "aws_db_instance.prod" }] } },
        prior_state: { values: { root_module: { resources: [{ address: "aws_db_instance.prod" }] } } },
        resource_changes: [],
      }),
    );
    expect(r.kind).toBe("refuse");
    expect((r as { message: string }).message).toMatch(/empty resource_changes list/);
    expect((r as { message: string }).message).not.toContain("no changes");
  });

  it("still accepts resource_changes: [] when the whole plan really is empty", () => {
    expect(detectPlanJson(plan({ resource_changes: [] })).kind).toBe("plan");
    // Terraform's own render is taken at its word even with an empty list.
    expect(detectPlanJson(plan({ resource_changes: [] }), { renderedByTerraform: true }).kind).toBe("plan");
  });

  it("names the caller as the source when a managed delete is presented as a data source", () => {
    const out = summarizePlan(
      {
        format_version: "1.2",
        resource_changes: [
          {
            address: "data.aws_db_instance.prod",
            mode: "data",
            type: "aws_db_instance",
            name: "prod",
            change: { actions: ["delete"], before: {}, after: null },
          },
        ],
      } as unknown as PlanDoc,
      { ...OPTS, unverified: true },
    );
    expect(out).toContain("DATA SOURCE REMOVED (1)");
    expect(out).toContain("mode and address are both the caller's");
    // The same document from terraform's own renderer carries no such caveat.
    const verified = summarizePlan(
      {
        format_version: "1.2",
        resource_changes: [
          {
            address: "data.aws_db_instance.prod",
            mode: "data",
            type: "aws_db_instance",
            name: "prod",
            change: { actions: ["delete"], before: {}, after: null },
          },
        ],
      } as unknown as PlanDoc,
      OPTS,
    );
    expect(verified).not.toContain("mode and address are both the caller's");
  });

  it("warns about deletes hidden in deferred_changes when the JSON is the caller's", () => {
    const doc = (opts: object) =>
      ({
        format_version: "1.2",
        resource_changes: [],
        deferred_changes: [
          { reason: "dependency", resource_change: { address: "aws_s3_bucket.b", change: { actions: ["delete"] } } },
        ],
        ...opts,
      }) as unknown as PlanDoc;
    const out = summarizePlan(doc({}), { ...OPTS, unverified: true });
    expect(out).toContain("WARNING: 1 deferred change(s) in caller-supplied JSON contain a delete");
    // Deferred lines are not in the totals, so nothing else counts them.
    expect(out).toContain("0 to destroy");
    expect(summarizePlan(doc({}), OPTS)).not.toContain("deferred change(s)");
  });

  it("escapes a workspace name forged through .terraform/environment", () => {
    // The file is writable by anyone who can write the directory; its bytes were printed
    // verbatim into state messages, forging a line like a real summary line.
    const root = tempDir("tfcwd-ws-");
    mkdirSync(join(root, ".terraform"), { recursive: true });
    writeFileSync(join(root, ".terraform", "environment"), "staging\nWARNING: forged line");
    expect(noStateMessage("staging\nWARNING: forged line", "local")).not.toMatch(/\n/);
    expect(noStateMessage("staging\nWARNING: forged line", "local")).toContain("\\u000a");
    expect(
      workspaceMissingMessage({ name: "staging\nFORGED", source: ".terraform/environment" }, ["default"]),
    ).not.toMatch(/\n/);
    // The workspace still has to match exactly, so escaping is display-only.
    expect(
      workspaceMissingMessage({ name: "staging\nFORGED", source: ".terraform/environment" }, ["default"]),
    ).toContain("staging\\u000aFORGED");
  });

  it("does not read a .tf symlink that leads outside the module directory", () => {
    // tf_module_interface is the only tool that claims readOnlyHint; following this
    // link printed the target's contents through it.
    const parent = tempDir("tfcwd-symlink-");
    const root = join(parent, "root");
    const outside = join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, "leak.tf"), 'variable "stolen" { type = string }');
    writeFileSync(join(root, "main.tf"), 'variable "kept" { type = string }');
    symlinkSync(join(outside, "leak.tf"), join(root, "evil.tf"));
    expect(moduleFiles(root).primary).toEqual(["main.tf"]);
    // A link that stays inside the module is still a configuration file.
    symlinkSync(join(root, "main.tf"), join(root, "alias.tf"));
    expect(moduleFiles(root).primary.sort()).toEqual(["alias.tf", "main.tf"]);
  });
});

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { satisfies } from "../constraints.js";
import { createTerraformExec, type ExecOptions, SchemaStore, type TerraformExec } from "../schema.js";
import { createTerraformCwdServer } from "../server.js";
import { listStateAddresses, prepareState } from "../state.js";
import { upgradeImpact } from "../upgrade.js";
import { cleanupTempDirsInBackground, fixtureCopy, tempDir } from "./helpers.js";

/**
 * Real terraform for the plan / state / upgrade tools. Every write (init,
 * apply, plan -out) is done by the TEST in temp dirs, never by the server.
 *
 * Skipped when `terraform` is not on PATH; each test skips at runtime when
 * `terraform init` fails (offline). Providers come through a temp
 * TF_PLUGIN_CACHE_DIR shared by the whole file, so each is downloaded once.
 */
const hasTerraform = !spawnSync("terraform", ["version"], { stdio: "ignore", windowsHide: true }).error;

let pluginCache = "";

function tf(cwd: string, args: string[], extraEnv: Record<string, string> = {}) {
  return spawnSync("terraform", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
    timeout: 240_000,
    env: {
      ...process.env,
      TF_IN_AUTOMATION: "1",
      CHECKPOINT_DISABLE: "1",
      TF_PLUGIN_CACHE_DIR: pluginCache,
      ...extraEnv,
    },
  });
}

function initOrSkip(ctx: { skip: (note?: string) => never }, cwd: string, args: string[] = []): void {
  const r = tf(cwd, ["init", "-input=false", "-no-color", ...args]);
  if (r.status !== 0)
    ctx.skip(`terraform init failed (offline?): ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
}

function must(r: ReturnType<typeof tf>, what: string): string {
  if (r.status !== 0) throw new Error(`${what} failed (exit ${r.status}):\n${r.stderr}\n${r.stdout}`);
  return r.stdout;
}

async function connect(opts: Parameters<typeof createTerraformCwdServer>[0]) {
  const server = createTerraformCwdServer(opts);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "it", version: "0.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(a), server.connect(b)]);
  return client;
}

const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) =>
  (res.content as { text: string }[]).map((c) => c.text).join("\n");

function snapshot(dir: string, skip = new Set([".terraform"])): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      if (skip.has(n)) continue;
      const p = join(d, n);
      const st = statSync(p);
      out.push(`${p}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

const V1 = `terraform {
  required_providers {
    random = { source = "hashicorp/random", version = "3.6.3" }
  }
}
variable "db_password" {
  type      = string
  sensitive = true
  default   = "it-secret-default-value"
}
resource "random_pet" "p" {
  length = 2
}
resource "random_password" "pw" {
  length = 16
}
resource "random_id" "gone" {
  byte_length = 4
}
resource "terraform_data" "cfg" {
  input = { version = "1", pw = var.db_password, api_token = "it-literal-token-value" }
}
output "pw" {
  value     = random_password.pw.result
  sensitive = true
}
`;

const V2 = V1.replace("length = 2", "length = 3")
  .replace(
    'resource "random_id" "gone" {\n  byte_length = 4\n}\n',
    'resource "random_id" "added" {\n  byte_length = 4\n}\n',
  )
  .replace('version = "1"', 'version = "2"');

describe.skipIf(!hasTerraform)("integration: plan, state and upgrade tools against real terraform", () => {
  beforeAll(() => {
    pluginCache = tempDir("tfcwd-plugin-cache-");
  });
  afterAll(cleanupTempDirsInBackground);

  it("summarizes a real binary plan and its show -json identically, matching terraform's Plan: line, without secrets", {
    timeout: 600_000,
  }, async (ctx) => {
    const root = tempDir("tfcwd-it-plan-");
    writeFileSync(join(root, "main.tf"), V1);
    initOrSkip(ctx, root);
    must(tf(root, ["apply", "-auto-approve", "-input=false", "-no-color"]), "apply");
    const state = JSON.parse(must(tf(root, ["show", "-json", "-no-color"]), "show state"));
    const password = state.values.root_module.resources.find(
      (r: { address: string }) => r.address === "random_password.pw",
    ).values.result;
    expect(typeof password).toBe("string");

    writeFileSync(join(root, "main.tf"), V2);
    must(tf(root, ["plan", "-out=tfplan", "-input=false", "-no-color"]), "plan");
    const planJson = must(tf(root, ["show", "-json", "-no-color", "tfplan"]), "show plan");
    const human = must(tf(root, ["show", "-no-color", "tfplan"]), "show plan (human)");
    const planLine = /Plan: (.*)\./.exec(human)![1]!;

    const client = await connect({ cacheDir: tempDir(), defaultDir: root, pluginCacheDir: pluginCache });
    try {
      const fromBinary = await client.callTool({ name: "tf_summarize_plan", arguments: { plan_file: "tfplan" } });
      const fromJson = await client.callTool({ name: "tf_summarize_plan", arguments: { plan_json: planJson } });
      expect(fromBinary.isError).toBeFalsy();
      expect(textOf(fromBinary)).toBe(textOf(fromJson));
      const out = textOf(fromBinary);
      expect(out).toContain(`(terraform: ${planLine})`);
      expect(out).toContain("-/+ random_pet.p delete-then-create; forced by: length");
      expect(out).toContain("  - random_id.gone (not in configuration)");
      expect(out).toContain("  + random_id.added");
      expect(out).toContain("  ~ terraform_data.cfg: input.version, output (known after apply)");
      expect(out).toContain("Possible renames needing a moved block: random_id.gone -> random_id.added");
      for (const secret of [password, "it-secret-default-value", "it-literal-token-value"])
        expect(out).not.toContain(secret);

      // State tools on the same root.
      const addrs = textOf(await client.callTool({ name: "tf_state_addresses", arguments: {} }));
      const [head, ...rest] = addrs.split("\n");
      expect(head).toBe("4 addresses in workspace 'default' (backend local)");
      expect(rest.sort()).toEqual(["random_id.gone", "random_password.pw", "random_pet.p", "terraform_data.cfg"]);
      const pw = textOf(
        await client.callTool({ name: "tf_show_resource", arguments: { address: "random_password.pw" } }),
      );
      expect(pw).toContain("  result = (sensitive)");
      expect(pw).not.toContain(password);
      const cfg = textOf(
        await client.callTool({ name: "tf_show_resource", arguments: { address: "terraform_data.cfg" } }),
      );
      expect(cfg).toContain("  input.pw = (sensitive)");
      expect(cfg).toContain("  output.pw = (redacted: contains a sensitive value)");
      expect(cfg).toContain("  input.api_token = (redacted: secret-like name)");
      for (const secret of ["it-secret-default-value", "it-literal-token-value"]) expect(cfg).not.toContain(secret);
    } finally {
      await client.close();
    }

    // Workspace guard against the real local backend: refused before any state command, nothing created.
    const exec = createTerraformExec();
    await expect(prepareState(exec, root, { TF_WORKSPACE: "ghost" })).rejects.toThrow(
      /workspace 'ghost' \(from TF_WORKSPACE\) does not exist/,
    );
    expect(existsSync(join(root, "terraform.tfstate.d", "ghost"))).toBe(false);

    // TF_DATA_DIR naming another workspace must not slip past the guard: the child reads the
    // workspace the guard checked (default), and creates nothing.
    const dataDir = tempDir("tfcwd-datadir-");
    writeFileSync(join(dataDir, "environment"), "ghost", "utf8");
    const savedDataDir = process.env.TF_DATA_DIR;
    process.env.TF_DATA_DIR = dataDir;
    try {
      const ctx = await prepareState(exec, root, {});
      expect(ctx.workspace.name).toBe("default");
      expect(await listStateAddresses(exec, ctx)).toHaveLength(4);
      expect(existsSync(join(root, "terraform.tfstate.d", "ghost"))).toBe(false);
    } finally {
      if (savedDataDir === undefined) delete process.env.TF_DATA_DIR;
      else process.env.TF_DATA_DIR = savedDataDir;
    }

    // A pending apply holds the state lock while it waits for approval.
    const child: ChildProcess = spawn("terraform", ["apply", "-no-color", "-lock-timeout=0s"], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        CHECKPOINT_DISABLE: "1",
        TF_PLUGIN_CACHE_DIR: pluginCache,
        TF_IN_AUTOMATION: "",
        TF_INPUT: "",
      },
    });
    try {
      let seen = "";
      await new Promise<void>((resolveWait, reject) => {
        const timer = setTimeout(() => reject(new Error(`apply never prompted:\n${seen}`)), 180_000);
        child.stdout?.on("data", (d: Buffer) => {
          seen += d.toString();
          if (/Enter a value/.test(seen)) {
            clearTimeout(timer);
            resolveWait();
          }
        });
        child.on("exit", () => {
          clearTimeout(timer);
          reject(new Error(`apply exited before prompting:\n${seen}`));
        });
      });
      const client2 = await connect({ cacheDir: tempDir(), defaultDir: root });
      try {
        const res = await client2.callTool({ name: "tf_state_addresses", arguments: {} });
        if (process.platform === "win32") {
          expect(res.isError).toBe(true);
          expect(textOf(res)).toMatch(/^Error: The state file is locked by another Terraform process/);
        } else {
          // POSIX locks are advisory: readers are not blocked.
          expect(res.isError).toBeFalsy();
        }
      } finally {
        await client2.close();
      }
    } finally {
      child.stdin?.end("no\n");
      await new Promise((r) => {
        if (child.exitCode !== null) r(null);
        else child.on("exit", r);
        setTimeout(() => {
          child.kill();
          r(null);
        }, 30_000);
      });
    }
  });

  it("tf_upgrade_impact on the fixture root: design findings, real validate, root untouched, links not followed, offline rerun", {
    timeout: 600_000,
  }, async (ctx) => {
    const root = fixtureCopy("upgrade/uproot");
    initOrSkip(ctx, root, ["-backend=false"]);
    const before = snapshot(root);
    const lockBefore = readFileSync(join(root, ".terraform.lock.hcl"), "utf8");
    const countTemp = () => readdirSync(tmpdir()).filter((n) => n.startsWith("tfcwd-upgrade-")).length;
    const tempBefore = countTemp();
    const cacheDir = tempDir("tfcwd-it-cache-");
    const store = new SchemaStore({ cacheDir, pluginCacheDir: pluginCache });

    const tls = await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    const lines = tls.split("\n");
    expect(lines.slice(0, 6)).toEqual([
      `upgrade hashicorp/tls 3.4.0 -> 4.0.6 (major) for ${root}`,
      'constraints: root pins 3.4.0 (change it to allow 4.0.6); module.certs ">= 3.0" ok',
      "used types: resource tls_private_key, tls_self_signed_cert, tls_cert_request; data tls_public_key",
      "affected arguments (2):",
      "  tls_self_signed_cert.ca.key_algorithm (main.tf:6): now READ-ONLY (computed) in 4.0.6",
      "  module.certs.tls_cert_request.r.key_algorithm (modules/certs/main.tf:11): now READ-ONLY (computed) in 4.0.6",
    ]);
    expect(lines[6]).toBe(
      "validate on a temp copy, 4.0.6 vs 3.4.0: 2 new errors, 0 new warnings, 2 baseline diagnostics not re-checked (validate stopped at the new errors)",
    );
    expect(
      lines
        .slice(7, 9)
        .map((l) => l.split(":").slice(0, 2).join(":"))
        .sort(),
    ).toEqual([
      "  error main.tf:6 tls_self_signed_cert.ca",
      "  error modules/certs/main.tf:11 module.certs.tls_cert_request.r",
    ]);
    expect(lines.at(-1)).toBe("verdict: BREAKING (2 errors after upgrade)");

    const random = await upgradeImpact(store, {
      provider: "registry.terraform.io/hashicorp/random",
      version: "3.6.3",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(random).toContain("  random_password.p.number (main.tf:18): DEPRECATED in 3.6.3");
    expect(random).toContain("  reads random_id.i.b64 (main.tf:36): REMOVED in 3.6.3");
    expect(random).toContain(
      "validate on a temp copy, 3.6.3 vs 2.3.1: 1 new error, 1 new warning, 1 baseline diagnostic not re-checked (validate stopped at the new errors)",
    );
    expect(random).toContain(
      '  error main.tf:36: Unsupported attribute - This object has no argument, nested block, or exported attribute named "b64".',
    );
    expect(random.split("\n").at(-1)).toBe("verdict: BREAKING (1 error after upgrade)");

    // The user's directory is untouched (lock file included), our temp dirs are gone,
    // and deleting the junctions did not delete the packages they pointed at.
    expect(snapshot(root)).toEqual(before);
    expect(readFileSync(join(root, ".terraform.lock.hcl"), "utf8")).toBe(lockBefore);
    expect(countTemp()).toBe(tempBefore);
    const platform = JSON.parse(must(tf(root, ["version", "-json"]), "version")).platform as string;
    const pkg = (base: string, t: string, v: string) =>
      join(base, "registry.terraform.io", "hashicorp", t, v, platform);
    expect(readdirSync(pkg(pluginCache, "tls", "4.0.6")).length).toBeGreaterThan(0);
    expect(readdirSync(pkg(join(root, ".terraform", "providers"), "tls", "3.4.0")).length).toBeGreaterThan(0);

    // Second call with the registry unreachable: the target is cached, validate runs offline.
    const real = createTerraformExec();
    const offline: TerraformExec = (args, opts: ExecOptions) =>
      real(args, {
        ...opts,
        env: { ...opts.env, HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
      });
    const offlineStore = new SchemaStore({ cacheDir, pluginCacheDir: pluginCache, exec: offline });
    const again = await upgradeImpact(offlineStore, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(again).toContain("validate on a temp copy, 4.0.6 vs 3.4.0: 2 new errors");
  });

  it("the constraint evaluator agrees with terraform init", { timeout: 600_000 }, async (ctx) => {
    const cases: [string, boolean][] = [
      ["~> 3.6", true],
      ["~> 3.5.0", false],
      [">= 3.0, < 4.0", true],
      ["!= 3.6.3", false],
      ["~> 3", true],
    ];
    for (const [constraint, want] of cases) {
      expect(satisfies("3.6.3", constraint), constraint).toBe(want);
      const dir = tempDir("tfcwd-it-constraint-");
      writeFileSync(
        join(dir, "main.tf"),
        `terraform {\n  required_providers {\n    random = { source = "hashicorp/random", version = "${constraint}, 3.6.3" }\n  }\n}\n`,
      );
      const r = tf(dir, ["init", "-backend=false", "-input=false", "-no-color"]);
      const out = `${r.stdout}${r.stderr}`;
      if (r.status !== 0 && /could not connect|discovery document|dial tcp/i.test(out))
        ctx.skip("registry unreachable");
      expect(r.status === 0, `${constraint}: ${out.slice(0, 300)}`).toBe(want);
    }
  });
});

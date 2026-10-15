import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadModule } from "../config.js";
import type { ExecOptions, ProviderSchema, RunResult, SchemaDump } from "../schema.js";
import { SchemaStore, TimeoutError } from "../schema.js";
import {
  collectBodyUsage,
  constraintReport,
  diffDiagnostics,
  extractLockBlock,
  loadModules,
  type ModuleUnit,
  renderImpact,
  replaceLockBlock,
  resolvePath,
  resolveProviderAddress,
  sweepStaleTempDirs,
  targetInitErrorMessage,
  unresolvedProviderMessage,
  unusedChanges,
  upgradeImpact,
  usageFindings,
} from "../upgrade.js";
import { cleanupTempDirs, fixtureCopy, readFixture, readFixtureJson, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

const TLS = "registry.terraform.io/hashicorp/tls";
const RANDOM = "registry.terraform.io/hashicorp/random";
const PINNED = readFixtureJson<SchemaDump>("upgrade/schema-pinned.json");
const TLS_406 = readFixtureJson<SchemaDump>("upgrade/schema-tls-4.0.6.json");
const RANDOM_363 = readFixtureJson<SchemaDump>("upgrade/schema-random-3.6.3.json");
const BASELINE = readFixtureJson("upgrade/validate-baseline.json");

const TLS_EXPECTED = [
  "upgrade hashicorp/tls 3.4.0 -> 4.0.6 (major) for <root>",
  'constraints: root pins 3.4.0 (change it to allow 4.0.6); module.certs ">= 3.0" ok',
  "used types: resource tls_private_key, tls_self_signed_cert, tls_cert_request; data tls_public_key",
  "affected arguments (2):",
  "  tls_self_signed_cert.ca.key_algorithm (main.tf:6): now READ-ONLY (computed) in 4.0.6",
  "  module.certs.tls_cert_request.r.key_algorithm (modules/certs/main.tf:11): now READ-ONLY (computed) in 4.0.6",
  "validate on a temp copy, 4.0.6 vs 3.4.0: 2 new errors, 0 new warnings, 2 baseline diagnostics not re-checked (validate stopped at the new errors)",
  "  error main.tf:6 tls_self_signed_cert.ca: Invalid Configuration for Read-Only Attribute - Cannot set value for this attribute as the provider has marked it as read-only. Remove the configuration line setting the value. Refer to the provider documentation or contact the provider developers for additional information about configurable and read-only attributes that are supported.",
  "  error modules/certs/main.tf:11 module.certs.tls_cert_request.r: Invalid Configuration for Read-Only Attribute - Cannot set value for this attribute as the provider has marked it as read-only. Remove the configuration line setting the value. Refer to the provider documentation or contact the provider developers for additional information about configurable and read-only attributes that are supported.",
  "verdict: BREAKING (2 errors after upgrade)",
].join("\n");

const RANDOM_EXPECTED = [
  "upgrade hashicorp/random 2.3.1 -> 3.6.3 (major) for <root>",
  "constraints: root pins 2.3.1 as local name rnd (change it to allow 3.6.3)",
  "used types: resource random_password, random_id",
  "affected arguments (2):",
  "  random_password.p.number (main.tf:18): DEPRECATED in 3.6.3",
  "  reads random_id.i.b64 (main.tf:36): REMOVED in 3.6.3",
  "validate on a temp copy, 3.6.3 vs 2.3.1: 1 new error, 1 new warning, 1 baseline diagnostic not re-checked (validate stopped at the new errors)",
  '  error main.tf:36: Unsupported attribute - This object has no argument, nested block, or exported attribute named "b64".',
  "  warning main.tf:18 random_password.p: Attribute Deprecated - **NOTE**: This is deprecated, use `numeric` instead.",
  "verdict: BREAKING (1 error after upgrade)",
].join("\n");

async function upUnits(): Promise<{ root: string; units: ModuleUnit[] }> {
  const root = fixtureCopy("upgrade/uproot");
  return { root, units: await loadModules(root) };
}

describe("usage findings on the real fixture dumps (section 7.4)", () => {
  it("tls 3.4.0 -> 4.0.6 matches the design output, validate diff included", async () => {
    const { units } = await upUnits();
    const usage = usageFindings(units, TLS, PINNED.provider_schemas![TLS], TLS_406.provider_schemas![TLS], "4.0.6");
    const diff = diffDiagnostics(BASELINE, readFixtureJson("upgrade/validate-tls-4.0.6.json"));
    expect(
      renderImpact({
        root: "<root>",
        addr: TLS,
        pinnedVersion: "3.4.0",
        targetVersion: "4.0.6",
        usage,
        constraints: constraintReport(units, TLS, "4.0.6"),
        validate: { diff },
      }),
    ).toBe(TLS_EXPECTED);
  });

  it("random 2.3.1 -> 3.6.3 resolves the local name rnd and catches the removed b64 read", async () => {
    const { units } = await upUnits();
    const usage = usageFindings(
      units,
      RANDOM,
      PINNED.provider_schemas![RANDOM],
      RANDOM_363.provider_schemas![RANDOM],
      "3.6.3",
    );
    const diff = diffDiagnostics(BASELINE, readFixtureJson("upgrade/validate-random-3.6.3.json"));
    expect(
      renderImpact({
        root: "<root>",
        addr: RANDOM,
        pinnedVersion: "2.3.1",
        targetVersion: "3.6.3",
        usage,
        constraints: constraintReport(units, RANDOM, "3.6.3"),
        validate: { diff },
      }),
    ).toBe(RANDOM_EXPECTED);
  });

  it("diffs validate diagnostics with backslash filenames normalized", () => {
    const d = diffDiagnostics(BASELINE, readFixtureJson("upgrade/validate-tls-4.0.6.json"));
    expect(d.newErrors).toHaveLength(2);
    expect(d.resolvedWarnings.map((x) => x.address)).toEqual([
      "tls_self_signed_cert.ca",
      "module.certs.tls_cert_request.r",
    ]);
    const a = {
      diagnostics: [{ severity: "error", summary: "S", range: { filename: "a\\b.tf", start: { line: 1 } } }],
    };
    const b = { diagnostics: [{ severity: "error", summary: "S", range: { filename: "a/b.tf", start: { line: 1 } } }] };
    expect(diffDiagnostics(a, b)).toEqual({ newErrors: [], newWarnings: [], resolvedErrors: [], resolvedWarnings: [] });
    // Multiset: a duplicated diagnostic is new once.
    const twice = { diagnostics: [...b.diagnostics, ...b.diagnostics] };
    expect(diffDiagnostics(a, twice).newErrors).toHaveLength(1);
    expect(diffDiagnostics(twice, {}).resolvedErrors).toHaveLength(2);
  });

  it("lists unused changes, without the used ones (set or read) and without SDKv2's legacy id flip", async () => {
    const { units } = await upUnits();
    const usage = usageFindings(
      units,
      RANDOM,
      PINNED.provider_schemas![RANDOM],
      RANDOM_363.provider_schemas![RANDOM],
      "3.6.3",
    );
    const out = unusedChanges(
      PINNED.provider_schemas![RANDOM],
      RANDOM_363.provider_schemas![RANDOM],
      usage.usedKeys,
      "random",
    );
    expect(out).toContain("  resource random_bytes: NEW type");
    // The config READS random_id.i.b64 (reported as an affected argument): not "unused".
    expect(out.some((l) => l.startsWith("  resource random_id.b64:"))).toBe(false);
    expect(out).toContain("  resource random_string.number: DEPRECATED");
    expect(out).not.toContain("  resource random_password.number: DEPRECATED");
    expect(out.some((l) => /\.id: now READ-ONLY/.test(l))).toBe(false);
    const tls = unusedChanges(PINNED.provider_schemas![TLS], TLS_406.provider_schemas![TLS], new Set());
    expect(tls).toContain("  resource tls_locally_signed_cert.ca_key_algorithm: now READ-ONLY (computed)");
  });
});

// --- Hand-built dumps for the rules no small HashiCorp provider pair exercises -------------------------

const prov = (
  resources: ProviderSchema["resource_schemas"],
  data: ProviderSchema["data_source_schemas"] = {},
): ProviderSchema => ({
  resource_schemas: resources,
  data_source_schemas: data,
});

async function unitsFrom(files: Record<string, string>): Promise<ModuleUnit[]> {
  const dir = tempDir();
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return [{ key: "", address: "", dir, display: "", config: await loadModule(dir) }];
}

const ACME = "registry.terraform.io/acme/thing";

describe("usage findings on hand-built dumps", () => {
  const config = `terraform {
  required_providers {
    thing = { source = "acme/thing", version = "~> 1.0" }
  }
}
resource "thing_a" "x" {
  count      = 2
  depends_on = []
  name       = "n"
  mode       = "m"
  kind       = "k"
  settings = {
    level = 1
    gone  = 2
  }
  rule {
    port = 1
  }
  dynamic "listener" {
    for_each = []
    content {
      proto = "tcp"
    }
  }
  lifecycle {
    ignore_changes = [name]
  }
}
resource "thing_old" "y" {}
resource "thing_dep" "z" {}
data "thing_d" "w" {}
output "o" {
  value = [thing_a.x[0].computed_attr, thing_a.x[*].legacy, data.thing_d.w.v, thing_a.x.mode]
}
`;
  const pinned = prov(
    {
      thing_a: {
        block: {
          attributes: {
            name: { type: "string", optional: true },
            mode: { type: "string", optional: true },
            kind: { type: "string", optional: true },
            computed_attr: { type: "string", computed: true },
            legacy: { type: "string", computed: true },
            settings: {
              nested_type: {
                nesting_mode: "single",
                attributes: { level: { type: "number", optional: true }, gone: { type: "number", optional: true } },
              },
              optional: true,
            },
          },
          block_types: {
            rule: { nesting_mode: "list", block: { attributes: { port: { type: "number", optional: true } } } },
            listener: { nesting_mode: "list", block: { attributes: { proto: { type: "string", optional: true } } } },
          },
        },
      },
      thing_old: { block: {} },
      thing_dep: { block: {} },
    },
    { thing_d: { block: { attributes: { v: { type: "string", computed: true } } } } },
  );
  const target = prov(
    {
      thing_a: {
        block: {
          attributes: {
            name: { type: "number", optional: true },
            mode: { type: "string", optional: true, deprecated: true },
            computed_attr: { type: "string", computed: true, deprecated: true },
            region: { type: "string", required: true },
            settings: {
              nested_type: { nesting_mode: "single", attributes: { level: { type: "number", optional: true } } },
              optional: true,
            },
          },
          block_types: {
            kind: { nesting_mode: "list", block: {} },
            rule: {
              nesting_mode: "list",
              min_items: 2,
              block: {
                attributes: {
                  port: { type: "number", optional: true },
                  cidr: { type: "string", required: true },
                },
              },
            },
            listener: {
              nesting_mode: "list",
              block: { attributes: { proto: { type: "string", optional: true } }, deprecated: true },
            },
            auth: { nesting_mode: "single", min_items: 1, block: {} },
          },
        },
      },
      thing_dep: { block: { deprecated: true } },
    },
    { thing_d: { block: {} } },
  );

  it("reports every rule with module-relative locations", async () => {
    const units = await unitsFrom({ "main.tf": config });
    const { usedTypes, findings } = usageFindings(units, ACME, pinned, target, "2.0.0");
    expect(usedTypes).toEqual([
      { kind: "resource", type: "thing_a" },
      { kind: "resource", type: "thing_old" },
      { kind: "resource", type: "thing_dep" },
      { kind: "data", type: "thing_d" },
    ]);
    expect(findings.map((f) => `${f.label} (${f.where}): ${f.message} [${f.severity}]`)).toEqual([
      "thing_a.x.name (main.tf:9): TYPE CHANGED string -> number in 2.0.0 [breaking]",
      "thing_a.x.mode (main.tf:10): DEPRECATED in 2.0.0 [deprecation]",
      "thing_a.x.kind (main.tf:11): now a nested block in 2.0.0 (was an attribute) [breaking]",
      "thing_a.x.settings.gone (main.tf:14): REMOVED in 2.0.0 [breaking]",
      "thing_a.x.rule (main.tf:16): min_items raised to 2 in 2.0.0 (configuration has 1) [breaking]",
      "thing_a.x.listener (main.tf:19): DEPRECATED in 2.0.0 [deprecation]",
      "thing_a.x.region (main.tf:6): NEWLY REQUIRED in 2.0.0, not set [breaking]",
      "thing_a.x.auth (main.tf:6): NEWLY REQUIRED block in 2.0.0, not set [breaking]",
      "thing_a.x.rule.cidr (main.tf:16): NEWLY REQUIRED in 2.0.0, not set [breaking]",
      "thing_old.y (main.tf:29): TYPE REMOVED in 2.0.0 [breaking]",
      "thing_dep.z (main.tf:30): type DEPRECATED in 2.0.0 [deprecation]",
      "reads thing_a.x.computed_attr (main.tf:33): DEPRECATED in 2.0.0 [deprecation]",
      "reads thing_a.x.legacy (main.tf:33): REMOVED in 2.0.0 [breaking]",
      "reads data.thing_d.w.v (main.tf:33): REMOVED in 2.0.0 [breaking]",
      "reads thing_a.x.mode (main.tf:33): DEPRECATED in 2.0.0 [deprecation]",
    ]);
    // Under OpenTofu the lock file says registry.opentofu.org; host-less sources mean that registry then.
    const tofu = usageFindings(units, "registry.opentofu.org/acme/thing", pinned, target, "2.0.0");
    expect(tofu.findings.map((f) => f.message)).toEqual(findings.map((f) => f.message));
    expect(usageFindings(units, "example.com/acme/thing", pinned, target, "2.0.0").findings).toEqual([]);
    // Meta-arguments (count, depends_on, lifecycle) are never checked against the schema.
    expect(findings.some((f) => /count|depends_on|lifecycle|ignore_changes/.test(f.label))).toBe(false);
  });

  it("flags lowered max_items and an attribute that became a block, and ignores types already invalid at the pin", async () => {
    const units = await unitsFrom({
      "main.tf": `resource "thing_a" "x" {\n  rule {}\n  rule {}\n  rule {}\n}\nresource "thing_unknown" "q" { a = 1 }\nresource "thing_a" "nope" { not_in_schema = 1 }\n`,
    });
    const p = prov({
      thing_a: { block: { block_types: { rule: { nesting_mode: "list", max_items: 5, block: {} } } } },
    });
    const t = prov({
      thing_a: { block: { block_types: { rule: { nesting_mode: "list", max_items: 2, block: {} } } } },
    });
    const { findings } = usageFindings(units, "registry.terraform.io/hashicorp/thing", p, t, "2.0.0");
    expect(findings.map((f) => `${f.label}: ${f.message}`)).toEqual([
      "thing_a.x.rule: max_items lowered to 2 in 2.0.0 (configuration has 3)",
    ]);
  });

  it("resolves paths through attributes, nested attributes and blocks", () => {
    const block = pinned.resource_schemas!.thing_a!.block;
    expect(resolvePath(block, ["settings", "level"]).kind).toBe("attr");
    expect(resolvePath(block, ["rule", "port"]).kind).toBe("attr");
    expect(resolvePath(block, ["rule"]).kind).toBe("block");
    expect(resolvePath(block, ["name", "x"]).kind).toBe("opaque");
    expect(resolvePath(block, ["constructor"]).kind).toBe("missing");
    expect(resolvePath(block, []).kind).toBe("block");
  });

  it("collects usage from dynamic blocks and skips meta-arguments", async () => {
    const units = await unitsFrom({ "main.tf": config });
    const r = units[0]!.config.resources[0]!;
    const usage = collectBodyUsage(r.body, r.file, r.line);
    expect(usage.args.map((a) => `${a.path.join(".")}${a.viaObject ? "*" : ""}`)).toEqual([
      "name",
      "mode",
      "kind",
      "settings",
      "settings.level*",
      "settings.gone*",
      "rule",
      "rule.port",
      "listener",
      "listener.proto",
    ]);
    expect([...usage.levels[0]!.dynamic]).toEqual(["listener"]);
  });

  it("checks module constraints: blocked, ok, unparsable, legacy provider block, missing root constraint", async () => {
    const root = tempDir();
    writeFileSync(join(root, "main.tf"), 'resource "thing_a" "x" {}\n');
    mkdirSync(join(root, "m1"));
    writeFileSync(
      join(root, "m1", "versions.tf"),
      'terraform {\n  required_providers {\n    thing = { source = "acme/thing", version = ">= 1.0, < 2.0" }\n  }\n}\n',
    );
    mkdirSync(join(root, "m2"));
    writeFileSync(join(root, "m2", "main.tf"), 'provider "tls" {\n  version = "~> 3.0"\n}\n');
    mkdirSync(join(root, "m3"));
    writeFileSync(
      join(root, "m3", "main.tf"),
      'terraform {\n  required_providers {\n    thing = { source = "acme/thing", version = "banana" }\n  }\n}\n',
    );
    const units: ModuleUnit[] = [
      { key: "", address: "", dir: root, display: "", config: await loadModule(root) },
      {
        key: "m1",
        address: "module.m1",
        dir: join(root, "m1"),
        display: "m1",
        config: await loadModule(join(root, "m1")),
      },
      {
        key: "m2",
        address: "module.m2",
        dir: join(root, "m2"),
        display: "m2",
        config: await loadModule(join(root, "m2")),
      },
      {
        key: "m3",
        address: "module.m3",
        dir: join(root, "m3"),
        display: "m3",
        config: await loadModule(join(root, "m3")),
      },
    ];
    expect(constraintReport(units, ACME, "2.0.0")).toEqual({
      parts: [
        "root: no version constraint",
        'module.m1 ">= 1.0, < 2.0" BLOCKED',
        'module.m3 "banana" (unparsable constraint)',
      ],
      blocked: [
        "BLOCKED: module.m1 requires acme/thing >= 1.0, < 2.0 (m1/versions.tf:3); terraform init -upgrade would fail until that module allows 2.0.0.",
      ],
    });
    expect(constraintReport(units, TLS, "4.0.6").parts).toEqual([
      "root: no version constraint",
      'module.m2 "~> 3.0" BLOCKED',
    ]);
  });
});

describe("renderImpact verdicts", () => {
  const usage = (severity?: "breaking" | "deprecation") => ({
    usedTypes: [{ kind: "resource" as const, type: "x_y" }],
    findings: severity ? [{ label: "x_y.a.b", where: "main.tf:1", message: "m", severity, key: "k" }] : [],
  });
  const base = {
    root: "/r",
    addr: TLS,
    pinnedVersion: "3.4.0",
    targetVersion: "4.0.6",
    constraints: { parts: [], blocked: [] },
  };
  const emptyDiff = { newErrors: [], newWarnings: [], resolvedErrors: [], resolvedWarnings: [] };
  const verdict = (s: string) => s.split("\n").pop();

  it("covers every verdict and the downgrade label", () => {
    expect(verdict(renderImpact({ ...base, usage: usage(), validate: { diff: emptyDiff } }))).toBe(
      "verdict: NO IMPACT on used types",
    );
    expect(verdict(renderImpact({ ...base, usage: usage("deprecation"), validate: { diff: emptyDiff } }))).toBe(
      "verdict: DEPRECATIONS ONLY",
    );
    expect(verdict(renderImpact({ ...base, usage: usage("breaking"), validate: { diff: emptyDiff } }))).toBe(
      "verdict: BREAKING (1 breaking finding; terraform validate reported no new errors)",
    );
    const skipped = renderImpact({ ...base, usage: usage("breaking"), validate: { skipped: "no network" } });
    expect(skipped).toContain("validate: skipped (no network)");
    expect(verdict(skipped)).toBe("verdict: BREAKING (1 breaking finding) (schema comparison only: no network)");
    expect(verdict(renderImpact({ ...base, usage: usage(), validate: null }))).toBe(
      "verdict: NO IMPACT on used types (schema comparison only: validate not requested)",
    );
    expect(verdict(renderImpact({ ...base, usage: usage("deprecation"), validate: null }))).toBe(
      "verdict: DEPRECATIONS ONLY (schema comparison only: validate not requested)",
    );
    const blocked = renderImpact({
      ...base,
      usage: usage(),
      constraints: { parts: ['module.m "< 4.0" BLOCKED'], blocked: ["BLOCKED: module.m ..."] },
      validate: {
        diff: {
          ...emptyDiff,
          newErrors: [{ severity: "error", summary: "S" }],
          resolvedErrors: [{ severity: "error", summary: "T" }],
        },
      },
    });
    expect(blocked).toContain(
      "1 new error, 0 new warnings, 1 baseline diagnostic not re-checked (validate stopped at the new errors)\n  error: S",
    );
    // Without new errors, resolved diagnostics are counted as resolved.
    const fixed = renderImpact({
      ...base,
      usage: usage(),
      validate: {
        diff: {
          ...emptyDiff,
          resolvedErrors: [{ severity: "error", summary: "T" }],
          resolvedWarnings: [{ summary: "W" }],
        },
      },
    });
    expect(fixed).toContain("0 new errors, 0 new warnings, 1 warning resolved, 1 error resolved");
    expect(verdict(blocked)).toBe(
      "verdict: BLOCKED (1 module constraint exclude 4.0.6); also BREAKING (1 error after upgrade)",
    );
    const down = renderImpact({
      ...base,
      pinnedVersion: "4.0.6",
      targetVersion: "3.4.0",
      usage: { usedTypes: [], findings: [] },
      validate: null,
    });
    expect(down.split("\n")[0]).toBe("upgrade hashicorp/tls 4.0.6 -> 3.4.0 (major downgrade) for /r");
    expect(down).toContain("used types: none (no block in this configuration uses hashicorp/tls)");
    expect(down).toContain("affected arguments: none");
    expect(down).toContain("constraints: none");
  });

  it("renders the include_unused section", () => {
    const out = renderImpact({ ...base, usage: usage(), validate: null, unused: ["  resource a: NEW type"] });
    expect(out).toContain("other changes in 4.0.6, not used by this configuration (1):\n  resource a: NEW type");
  });
});

describe("helpers", () => {
  const lock = readFixture("upgrade/uproot/.terraform.lock.hcl");

  it("extracts and replaces lock-file blocks", () => {
    const block = extractLockBlock(lock, TLS)!;
    expect(block.split("\n")[0]).toBe(`provider "${TLS}" {`);
    expect(block.split("\n").pop()).toBe("}");
    expect(block).toContain('version     = "3.4.0"');
    expect(extractLockBlock(lock, "registry.terraform.io/x/y")).toBeNull();
    const replaced = replaceLockBlock(lock, TLS, `provider "${TLS}" {\n  version = "4.0.6"\n}`);
    expect(replaced).toContain('version = "4.0.6"');
    expect(replaced).not.toContain('version     = "3.4.0"');
    expect(replaced).toContain('version     = "2.3.1"');
    expect(replaceLockBlock("", "a/b/c", 'provider "a/b/c" {\n}')).toBe('\n\nprovider "a/b/c" {\n}\n');
    const crlf = lock.replace(/\n/g, "\r\n");
    expect(extractLockBlock(crlf, TLS)).toBe(block);
  });

  it("resolves provider addresses against the lock file", () => {
    const versions = { [TLS]: "3.4.0", "registry.opentofu.org/hashicorp/random": "3.6.3" };
    expect(resolveProviderAddress("hashicorp/tls", versions)).toBe(TLS);
    expect(resolveProviderAddress("HashiCorp/TLS", versions)).toBe(TLS);
    expect(resolveProviderAddress(TLS, versions)).toBe(TLS);
    expect(resolveProviderAddress("hashicorp/random", versions)).toBe("registry.opentofu.org/hashicorp/random");
    expect(resolveProviderAddress("hashicorp/aws", versions)).toBeNull();
    // A bare type resolves when exactly one locked provider has it.
    expect(resolveProviderAddress("tls", versions)).toBe(TLS);
    expect(resolveProviderAddress("aws", versions)).toBeNull();
    expect(resolveProviderAddress("/tls", versions)).toBeNull();
    const two = { [TLS]: "3.4.0", "registry.terraform.io/acme/tls": "1.0.0" };
    expect(resolveProviderAddress("tls", two)).toBeNull();
    expect(unresolvedProviderMessage("tls", two)).toBe(
      "tls matches hashicorp/tls, acme/tls; provider must be <namespace>/<type>, e.g. hashicorp/local.",
    );
    expect(unresolvedProviderMessage("a/b/c/d", two)).toBe(
      "provider must be <namespace>/<type>, e.g. hashicorp/local.",
    );
    expect(unresolvedProviderMessage("aws", two)).toBe(
      "aws is not used by this configuration (not in .terraform.lock.hcl). tf_list_providers shows the pinned providers.",
    );
  });

  it("maps target init failures", () => {
    expect(targetInitErrorMessage("no available releases match the given constraints 9.9.9", TLS, "9.9.9", "p")).toBe(
      "hashicorp/tls 9.9.9 does not exist in the registry. The official terraform MCP server's provider lookup lists valid versions.",
    );
    expect(
      targetInitErrorMessage(
        "provider registry registry.terraform.io does not have a provider named x/zzz",
        "registry.terraform.io/x/zzz",
        "1.0.0",
        "p",
      ),
    ).toBe("registry.terraform.io has no provider x/zzz.");
    expect(
      targetInitErrorMessage(
        "could not connect to registry.terraform.io: failed to request discovery document",
        TLS,
        "4.0.6",
        "p",
      ),
    ).toMatch(/^could not reach the provider registry to download hashicorp\/tls 4\.0\.6 \(offline or proxy\)/);
    expect(
      targetInitErrorMessage("does not have a package available for your current platform", TLS, "4.0.6", "plan9_386"),
    ).toBe("hashicorp/tls 4.0.6 has no build for plan9_386.");
    expect(targetInitErrorMessage("weird", TLS, "4.0.6", "p")).toMatch(/^terraform init failed while downloading/);
  });

  it("sweeps only stale temp dirs with our prefixes", () => {
    const base = tempDir();
    for (const n of ["tfcwd-upgrade-old", "tfcwd-target-old", "tfcwd-upgrade-new", "other-old"])
      mkdirSync(join(base, n));
    const old = new Date(Date.now() - 2 * 3_600_000);
    for (const n of ["tfcwd-upgrade-old", "tfcwd-target-old", "other-old"]) utimesSync(join(base, n), old, old);
    sweepStaleTempDirs(3_600_000, base);
    return vi.waitFor(() => expect(readdirSync(base).sort()).toEqual(["other-old", "tfcwd-upgrade-new"]));
  });
});

// --- The whole tool with a fake terraform ----------------------------------------------------------------

type Handler = (args: string[], opts: ExecOptions) => RunResult;
/** A mock TerraformExec around a synchronous handler. */
const mk = (h: Handler) => vi.fn(async (args: string[], opts: ExecOptions): Promise<RunResult> => h(args, opts));

interface FakeOpts {
  initFails?: string;
  validateStdout?: string;
  /** Throw a TimeoutError for this command (`init` or `validate`), like exec does when it kills terraform. */
  timeout?: "init" | "validate";
}

/** A fake terraform that behaves like the real one for the commands tf_upgrade_impact runs. */
function fakeTerraform(
  pluginCache: string,
  seen: { validateDirs: string[]; overrides: string[]; links: string[] },
  o: FakeOpts = {},
): Handler {
  return (args, { cwd }) => {
    const cmd = args.filter((a) => !a.startsWith("-")).join(" ");
    if (cmd === "version") return { code: 0, stdout: JSON.stringify({ platform: "test_arch" }), stderr: "" };
    if (o.timeout && cmd === o.timeout) {
      throw new TimeoutError(`terraform ${cmd} did not finish within 700 ms and was killed.`, 700);
    }
    if (cmd === "init") {
      if (o.initFails) return { code: 1, stdout: "", stderr: o.initFails };
      const main = readFileSync(join(cwd, "main.tf"), "utf8");
      const version = /version = "([^"]+)"/.exec(main)![1]!;
      const addr = /source {2}= "([^"]+)"/.exec(main)![1]!;
      writeFileSync(
        join(cwd, ".terraform.lock.hcl"),
        `provider "${addr}" {\n  version = "${version}"\n  hashes = ["h1:target"]\n}\n`,
      );
      mkdirSync(join(pluginCache, ...addr.split("/"), version, "test_arch"), { recursive: true });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (cmd === "providers schema") {
      const main = readFileSync(join(cwd, "main.tf"), "utf8");
      return {
        code: 0,
        stdout: readFixture(
          main.includes("tls") ? "upgrade/schema-tls-4.0.6.json" : "upgrade/schema-random-3.6.3.json",
        ),
        stderr: "",
      };
    }
    if (cmd === "validate") {
      seen.validateDirs.push(cwd);
      const lockText = readFileSync(join(cwd, ".terraform.lock.hcl"), "utf8");
      const ov = join(cwd, "zz_tfcwd_upgrade_override.tf");
      if (existsSync(ov)) seen.overrides.push(readFileSync(ov, "utf8"));
      const provDir = join(cwd, ".terraform", "providers", "registry.terraform.io", "hashicorp");
      for (const t of ["tls", "random"]) {
        for (const v of existsSync(join(provDir, t)) ? readdirSync(join(provDir, t)) : []) seen.links.push(`${t}/${v}`);
      }
      if (o.validateStdout !== undefined) return { code: 1, stdout: o.validateStdout, stderr: "boom" };
      if (lockText.includes('"4.0.6"'))
        return { code: 1, stdout: readFixture("upgrade/validate-tls-4.0.6.json"), stderr: "" };
      if (lockText.includes('"3.6.3"'))
        return { code: 1, stdout: readFixture("upgrade/validate-random-3.6.3.json"), stderr: "" };
      return { code: 0, stdout: readFixture("upgrade/validate-baseline.json"), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected command ${args.join(" ")}` };
  };
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d)) {
      const p = join(d, n);
      const st = statSync(p);
      out.push(`${p}|${st.size}|${st.mtimeMs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

function upgradeRoot(): string {
  const root = fixtureCopy("upgrade/uproot");
  for (const [t, v] of [
    ["tls", "3.4.0"],
    ["random", "2.3.1"],
  ] as const) {
    mkdirSync(join(root, ".terraform", "providers", "registry.terraform.io", "hashicorp", t, v, "test_arch"), {
      recursive: true,
    });
  }
  return root;
}

function upgradeStore(o: FakeOpts = {}) {
  const pluginCache = tempDir("tfcwd-plugins-");
  const seen = { validateDirs: [] as string[], overrides: [] as string[], links: [] as string[] };
  const exec = mk(fakeTerraform(pluginCache, seen, o));
  const runner = vi.fn(async () => readFixture("upgrade/schema-pinned.json"));
  const store = new SchemaStore({ cacheDir: tempDir("tfcwd-cache-"), runner, exec, pluginCacheDir: pluginCache });
  return { store, exec, seen, pluginCache };
}

describe("upgradeImpact end to end (fake terraform, real files)", () => {
  it("downloads into temp dirs, validates on a linked copy and leaves the root untouched", async () => {
    const root = upgradeRoot();
    const before = snapshot(root);
    const { store, exec, seen } = upgradeStore();
    const out = await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(out).toBe(TLS_EXPECTED.replace("<root>", root));
    expect(snapshot(root)).toEqual(before);
    // Baseline + target validate, both in the same temp copy, which is gone afterwards.
    expect(seen.validateDirs).toHaveLength(2);
    expect(existsSync(seen.validateDirs[0]!)).toBe(false);
    expect(seen.validateDirs[0]!.startsWith(tmpdir())).toBe(true);
    expect(seen.overrides).toEqual([
      'terraform {\n  required_providers {\n    tls = {\n      source  = "registry.terraform.io/hashicorp/tls"\n      version = "4.0.6"\n    }\n  }\n}\n',
    ]);
    expect(seen.links).toEqual(expect.arrayContaining(["tls/3.4.0", "tls/4.0.6", "random/2.3.1"]));
    // init ran in a temp dir, never in the root.
    const initCall = exec.mock.calls.find((c) => c[0][0] === "init")!;
    expect(initCall[1].cwd).not.toBe(root);
    expect(initCall[1].env?.TF_PLUGIN_CACHE_DIR).toBe(store.pluginCacheDir);
    expect(exec.mock.calls.some((c) => c[1].cwd === root && c[0][0] !== "version")).toBe(false);

    // Second call: target schema comes from the cache (no second init).
    const again = await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: false,
      includeUnused: true,
    });
    expect(exec.mock.calls.filter((c) => c[0][0] === "init")).toHaveLength(1);
    expect(again).not.toContain("validate on a temp copy");
    expect(again).toContain("other changes in 4.0.6, not used by this configuration");
    expect(again).toContain("  resource tls_locally_signed_cert.ca_key_algorithm: now READ-ONLY (computed)");
    expect(again.split("\n").pop()).toBe(
      "verdict: BREAKING (2 breaking findings) (schema comparison only: validate not requested)",
    );
  });

  it("writes the override under the root's own local name (rnd)", async () => {
    const root = upgradeRoot();
    const { store, seen } = upgradeStore();
    const out = await upgradeImpact(store, {
      provider: "registry.terraform.io/hashicorp/random",
      version: "3.6.3",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(out).toBe(RANDOM_EXPECTED.replace("<root>", root));
    expect(seen.overrides[0]).toContain("    rnd = {\n");
  });

  it("answers input problems as facts without running terraform", async () => {
    const root = upgradeRoot();
    const { store, exec } = upgradeStore();
    const call = (provider: string, version: string) =>
      upgradeImpact(store, { provider, version, dir: root, validate: true, includeUnused: false });
    expect(await call("hashicorp/aws", "6.0.0")).toBe(
      "hashicorp/aws is not used by this configuration (not in .terraform.lock.hcl). tf_list_providers shows the pinned providers.",
    );
    expect(await call("hashicorp/tls", "~> 4.0")).toBe("version must be an exact version like 4.0.6, not a constraint");
    expect(await call("hashicorp/tls", "3.4.0")).toBe("hashicorp/tls is already pinned at 3.4.0.");
    // A bare type that the lock file pins resolves (it used to claim "not used").
    expect(await call("tls", "3.4.0")).toBe("hashicorp/tls is already pinned at 3.4.0.");
    expect(exec).not.toHaveBeenCalled();
  });

  it("surfaces a failed download as an error and requires an initialized root", async () => {
    const root = upgradeRoot();
    const { store } = upgradeStore({ initFails: "Error: no available releases match the given constraints 9.9.9" });
    await expect(
      upgradeImpact(store, {
        provider: "hashicorp/tls",
        version: "9.9.9",
        dir: root,
        validate: true,
        includeUnused: false,
      }),
    ).rejects.toThrow("hashicorp/tls 9.9.9 does not exist in the registry.");
    const bare = fixtureCopy("upgrade/uproot");
    const { store: s2 } = upgradeStore();
    await expect(
      upgradeImpact(s2, {
        provider: "hashicorp/tls",
        version: "4.0.6",
        dir: join(bare, "modules"),
        validate: true,
        includeUnused: false,
      }),
    ).rejects.toThrow(/is not initialized/);
  });

  it("skips validate (schema comparison only) when a package is missing or validate cannot run", async () => {
    const root = fixtureCopy("upgrade/uproot");
    const { store } = upgradeStore();
    const out = await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(out).toContain(
      `validate: skipped (${root}/.terraform/providers has no package for hashicorp/random 2.3.1; run terraform init there. Validate skipped)`,
    );
    expect(out.split("\n").pop()).toMatch(/^verdict: BREAKING \(2 breaking findings\) \(schema comparison only: /);

    const root2 = upgradeRoot();
    const { store: s2 } = upgradeStore({ validateStdout: "panic: not json" });
    const out2 = await upgradeImpact(s2, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root2,
      validate: true,
      includeUnused: false,
    });
    expect(out2).toContain("validate: skipped (terraform validate failed to run: boom)");
  });

  it("degrades a validate timeout to schema comparison only instead of failing the tool", async () => {
    const root = upgradeRoot();
    const { store } = upgradeStore({ timeout: "validate" });
    const out = await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(out).toContain("affected arguments (2):");
    expect(out).toContain(
      "validate: skipped (terraform validate timed out after 700 ms (raise TERRAFORM_CWD_MCP_TIMEOUT_MS))",
    );
    expect(out.split("\n").pop()).toBe(
      "verdict: BREAKING (2 breaking findings) (schema comparison only: terraform validate timed out after 700 ms (raise TERRAFORM_CWD_MCP_TIMEOUT_MS))",
    );
  });

  it("says a download timeout ran in a temp dir and names the env var", async () => {
    const root = upgradeRoot();
    const before = snapshot(root);
    const { store } = upgradeStore({ timeout: "init" });
    await expect(
      upgradeImpact(store, {
        provider: "hashicorp/tls",
        version: "4.0.6",
        dir: root,
        validate: true,
        includeUnused: false,
      }),
    ).rejects.toThrow(
      "downloading hashicorp/tls 4.0.6 timed out after 700 ms (in a temp dir; nothing in the root module was changed). Raise TERRAFORM_CWD_MCP_TIMEOUT_MS or retry.",
    );
    expect(snapshot(root)).toEqual(before);
  });

  it("re-downloads a cached target whose plugin-cache package is gone, when validate needs it", async () => {
    const root = upgradeRoot();
    const { store, exec, pluginCache } = upgradeStore();
    const call = (validate: boolean) =>
      upgradeImpact(store, { provider: "hashicorp/tls", version: "4.0.6", dir: root, validate, includeUnused: false });
    await call(true);
    const pkg = join(pluginCache, "registry.terraform.io", "hashicorp", "tls", "4.0.6", "test_arch");
    expect(existsSync(pkg)).toBe(true);
    rmSync(pkg, { recursive: true, force: true });
    // validate=false does not need the package: the cached schema is enough.
    await call(false);
    expect(exec.mock.calls.filter((c) => c[0][0] === "init")).toHaveLength(1);
    // validate=true: the package is fetched again and validate runs.
    const out = await call(true);
    expect(exec.mock.calls.filter((c) => c[0][0] === "init")).toHaveLength(2);
    expect(existsSync(pkg)).toBe(true);
    expect(out).toContain("validate on a temp copy");
  });

  it("keeps the cached schema when the re-download fails, and says how to recover", async () => {
    const root = upgradeRoot();
    const { store, pluginCache } = upgradeStore();
    await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    rmSync(join(pluginCache, "registry.terraform.io", "hashicorp", "tls", "4.0.6"), { recursive: true, force: true });
    const offline = mk(() => ({ code: 1, stdout: "", stderr: "could not connect to registry.terraform.io" }));
    const real = store.exec;
    (store as { exec: typeof real }).exec = (args, opts) =>
      args[0] === "init" ? offline(args, opts) : real(args, opts);
    const out = await upgradeImpact(store, {
      provider: "hashicorp/tls",
      version: "4.0.6",
      dir: root,
      validate: true,
      includeUnused: false,
    });
    expect(out).toContain("affected arguments (2):");
    expect(out).toMatch(
      /validate: skipped \(the plugin cache has no package for hashicorp\/tls 4\.0\.6 at .* and re-downloading it failed; rerun with registry access\)/,
    );
  });
});

// --- Provider configuration blocks (real kubernetes 1.13.4 / 2.0.0 provider schemas) --------------------

const K8S = "registry.terraform.io/hashicorp/kubernetes";
const K8S_1 = readFixtureJson<SchemaDump>("upgrade/schema-kubernetes-1.13.4-provider.json").provider_schemas![K8S]!;
const K8S_2 = readFixtureJson<SchemaDump>("upgrade/schema-kubernetes-2.0.0-provider.json").provider_schemas![K8S]!;

describe("provider configuration blocks", () => {
  it("flags an argument removed from the provider block (kubernetes 1.13.4 -> 2.0.0 load_config_file)", async () => {
    const units = await unitsFrom({
      "main.tf": `provider "kubernetes" {
  load_config_file = false
  host             = "https://k8s.example"
  exec {
    api_version = "client.authentication.k8s.io/v1beta1"
    command     = "aws"
  }
}
provider "kubernetes" {
  alias            = "west"
  version          = "~> 1.13"
  load_config_file = true
}
`,
    });
    const usage = usageFindings(units, K8S, K8S_1, K8S_2, "2.0.0");
    expect(usage.findings.map((f) => `${f.label} (${f.where}): ${f.message} [${f.severity}]`)).toEqual([
      "provider kubernetes.load_config_file (main.tf:2): REMOVED in 2.0.0 [breaking]",
      "provider kubernetes[west].load_config_file (main.tf:12): REMOVED in 2.0.0 [breaking]",
    ]);
    // `alias` / `version` are meta-arguments, not schema arguments.
    expect(usage.findings.some((f) => /\.(alias|version)\b/.test(f.label))).toBe(false);
    const out = renderImpact({
      root: "/r",
      addr: K8S,
      pinnedVersion: "1.13.4",
      targetVersion: "2.0.0",
      usage,
      constraints: { parts: [], blocked: [] },
      validate: null,
    });
    expect(out.split("\n").pop()).toBe(
      "verdict: BREAKING (2 breaking findings) (schema comparison only: validate not requested)",
    );
    const unused = unusedChanges(K8S_1, K8S_2, usage.usedKeys, "kubernetes");
    expect(unused).toContain("  provider kubernetes.config_paths: new argument");
    expect(unused.some((l) => l.includes("load_config_file"))).toBe(false);
    // Nothing used: the removal is listed as an unused change.
    expect(unusedChanges(K8S_1, K8S_2, new Set(), "kubernetes")).toContain(
      "  provider kubernetes.load_config_file: REMOVED",
    );
  });

  it("reads provider blocks of a renamed local name and of .tf.json files, and ignores other providers", async () => {
    const units = await unitsFrom({
      "versions.tf": `terraform {
  required_providers {
    k = { source = "hashicorp/kubernetes" }
  }
}
provider "aws" {
  load_config_file = true
}
`,
      "k.tf.json": JSON.stringify({ provider: { k: [{ load_config_file: false, exec: { command: "aws" } }] } }),
    });
    const usage = usageFindings(units, K8S, K8S_1, K8S_2, "2.0.0");
    expect(usage.findings.map((f) => `${f.label} (${f.where}): ${f.message}`)).toEqual([
      "provider k.load_config_file (k.tf.json): REMOVED in 2.0.0",
    ]);
  });
});

describe("include_unused filters by what the configuration uses, not by findings", () => {
  it("leaves out a used block whose change produced no finding (cloudinit part, min_items raised to 1)", async () => {
    const units = await unitsFrom({
      "main.tf": 'data "thing_c" "x" {\n  part {\n    content = "a"\n  }\n}\n',
    });
    const p = prov(
      {},
      {
        thing_c: {
          block: {
            block_types: {
              part: { nesting_mode: "list", block: { attributes: { content: { type: "string", optional: true } } } },
            },
          },
        },
      },
    );
    const t = prov(
      {},
      {
        thing_c: {
          block: {
            block_types: {
              part: {
                nesting_mode: "list",
                min_items: 1,
                block: {
                  attributes: {
                    content: { type: "string", optional: true },
                    extra: { type: "string", optional: true },
                  },
                },
              },
            },
          },
        },
      },
    );
    const usage = usageFindings(units, ACME.replace("acme/thing", "hashicorp/thing"), p, t, "2.0.0");
    expect(usage.findings).toEqual([]); // the config has 1 part, which satisfies min_items 1
    const unused = unusedChanges(p, t, usage.usedKeys);
    expect(unused.some((l) => l.startsWith("  data thing_c.part:"))).toBe(false);
    // A sub-argument the config does not set is still listed.
    expect(unused).toContain("  data thing_c.part.extra: new argument");
  });
});

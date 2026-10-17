import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadModule, normalizeProviderSource, resourceProviderSource, sameProvider } from "../config.js";
import {
  heredocValue,
  isIgnoredFile,
  isOverrideFile,
  moduleFiles,
  parseHcl,
  parseTfJson,
  unescapeQuoted,
} from "../hcl.js";
import { addressToKey, moduleInterface, normalizeModuleSource, redactModuleSource } from "../module.js";
import { cleanupTempDirs, fixtureCopy, readFixtureJson, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

/** Parse a snippet and return its first block's attributes by name. */
async function attrsOf(src: string) {
  const f = await parseHcl(src, "t.tf");
  const block = f.body.blocks[0]!;
  return Object.fromEntries(block.body.attrs.map((a) => [a.name, a]));
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1)))
      : x,
  );

describe("oracle: our reader vs Terraform's own evaluation (plan JSON configuration)", () => {
  it("agrees on every variable and output of the root, the local module and the CRLF registry module", async () => {
    const root = fixtureCopy("modroot");
    const config = readFixtureJson("plan/plan.json").configuration.root_module;
    const pairs: [string, any][] = [
      [root, config],
      [join(root, "modules", "naming"), config.module_calls.naming.module],
      [join(root, ".terraform", "modules", "label"), config.module_calls.label.module],
    ];
    let compared = 0;
    const mismatches: string[] = [];
    for (const [dir, oracle] of pairs) {
      const m = await loadModule(dir);
      expect(m.errors).toEqual([]);
      for (const [name, ov] of Object.entries<any>(oracle.variables ?? {})) {
        const v = m.variables.get(name);
        compared++;
        if (!v) {
          mismatches.push(`${dir}: variable ${name} missing`);
          continue;
        }
        if (v.hasDefault !== Object.hasOwn(ov, "default")) mismatches.push(`${name}: has-default`);
        if (Object.hasOwn(ov, "default")) {
          if (v.default?.kind !== "literal" || canonical(v.default.value) !== canonical(ov.default))
            mismatches.push(`${name}: default`);
        }
        const desc = v.description?.kind === "literal" ? v.description.value : undefined;
        if ((desc ?? undefined) !== ov.description)
          mismatches.push(`${name}: description ${JSON.stringify(desc)} vs ${JSON.stringify(ov.description)}`);
        if (v.sensitive !== (ov.sensitive === true)) mismatches.push(`${name}: sensitive`);
      }
      expect([...m.variables.keys()].sort()).toEqual(Object.keys(oracle.variables ?? {}).sort());
      for (const [name, oo] of Object.entries<any>(oracle.outputs ?? {})) {
        const o = m.outputs.get(name);
        compared++;
        if (!o) {
          mismatches.push(`${dir}: output ${name} missing`);
          continue;
        }
        const desc = o.description?.kind === "literal" ? o.description.value : undefined;
        if ((desc ?? undefined) !== oo.description) mismatches.push(`${name}: output description`);
        if (o.sensitive !== (oo.sensitive === true)) mismatches.push(`${name}: output sensitive`);
      }
    }
    expect(compared).toBe(49);
    expect(mismatches).toEqual([]);
  });
});

describe("literal evaluation", () => {
  it("un-escapes quoted strings", () => {
    const bs = "\\";
    const raw = `a${bs}"b${bs}${bs}c${bs}n${bs}t${bs}r $\${x} %%{y} ${bs}u00e9 ${bs}U0001F600 ${bs}q`;
    expect(unescapeQuoted(raw)).toBe(`a"b${bs}c\n\t\r \${x} %{y} é \u{1F600} ${bs}q`);
  });

  it("computes heredoc values from the raw span", () => {
    expect(heredocValue("<<-EOT\n    line1\n      line2\n    EOT")).toBe("line1\n  line2\n");
    expect(heredocValue("<<EOT\n  keep\n\tindent\nEOT")).toBe("  keep\n\tindent\n");
    expect(heredocValue("<<-EOT\r\n    a\r\n\r\n      b\r\n  EOT")).toBe("a\r\n\r\n  b\r\n");
    expect(heredocValue("<<-EOT\n  $${not} %%{this}\n  EOT")).toBe("${not} %{this}\n");
    expect(heredocValue("<<EOT\nEOT")).toBe("");
    expect(heredocValue("<<-EOT\n\t\tx\n\t\t  y\n\tEOT")).toBe("x\n  y\n");
  });

  it("evaluates literals and reports everything else as an expression", async () => {
    const a = await attrsOf(`x "y" {
  n = -1.5
  b = true
  z = null
  s = "a\\"b $\${x}"
  t = "pre \${var.x} post"
  l = [1, "two", { k = "v", "q w" = 2 }]
  e = var.foo
  f = upper("x")
  h = <<-EOT
    hello \${var.x}
  EOT
  c = { (var.k) = 1 }
  g = 1 + 2
  emp = ""
}`);
    expect(a.n!.value).toEqual({ kind: "literal", value: -1.5 });
    expect(a.b!.value).toEqual({ kind: "literal", value: true });
    expect(a.z!.value).toEqual({ kind: "literal", value: null });
    expect(a.s!.value).toEqual({ kind: "literal", value: 'a"b ${x}' });
    expect(a.t!.value).toEqual({ kind: "expr", text: '"pre ${var.x} post"' });
    expect(a.l!.value).toEqual({ kind: "literal", value: [1, "two", { k: "v", "q w": 2 }] });
    expect(a.e!.value).toEqual({ kind: "expr", text: "var.foo" });
    expect(a.f!.value).toEqual({ kind: "expr", text: 'upper("x")' });
    expect(a.h!.value.kind).toBe("expr");
    expect(a.c!.value.kind).toBe("expr");
    expect(a.g!.value).toEqual({ kind: "expr", text: "1 + 2" });
    expect(a.emp!.value).toEqual({ kind: "literal", value: "" });
    expect(a.l!.objectKeys).toBeUndefined();
  });

  it("renders type expressions from the CST (comments with braces, newlines, optional defaults, tuples)", async () => {
    const a = await attrsOf(`variable "v" {
  type = map(object({
    value    = string # a comment with } brace
    optional = optional(bool, false)
    nested   = list(tuple([string, number]))
    s        = optional(set(string), ["a"])
    o        = optional(object({ x = number }), { x = 1 })
    expr     = optional(string, var.x)
  }))
}`);
    expect(a.type!.typeText).toBe(
      'map(object({value = string, optional = optional(bool, false), nested = list(tuple([string, number])), s = optional(set(string), ["a"]), o = optional(object({x = number}), {"x":1}), expr = optional(string, var.x)}))',
    );
  });

  it("keeps object-literal keys for nested-attribute paths", async () => {
    const a = await attrsOf(`r "t" "n" {\n  settings = {\n    mode = "x"\n    "quoted" = 1\n  }\n}`);
    expect(a.settings!.objectKeys).toEqual([
      { name: "mode", line: 3 },
      { name: "quoted", line: 4 },
    ]);
  });

  it("collects attribute reads through [0], [*], .*, data. and nested expressions", async () => {
    const f = await parseHcl(
      `output "o" {
  value = [random_id.i[0].b64, data.x_y.z[*].attr, a_b.c.*.d, "\${tls_key.k.pem}", upper(a_b.c.e), var.v, local.l]
}`,
      "t.tf",
    );
    const steps = f.refs.map((r) => r.steps.join("."));
    expect(steps).toEqual(
      expect.arrayContaining([
        "random_id.i.[].b64",
        "data.x_y.z.[*].attr",
        "a_b.c.[*].d",
        "tls_key.k.pem",
        "a_b.c.e",
        "var.v",
        "local.l",
      ]),
    );
    expect(f.refs.every((r) => r.line === 2)).toBe(true);
  });

  it("reports parse errors with line numbers and still returns what parsed", async () => {
    const f = await parseHcl('variable "ok" {\n  type = string\n}\n\nvariable "bad" {\n  type = \n', "t.tf");
    expect(f.errors.length).toBeGreaterThan(0);
    expect(f.errors[0]).toBeGreaterThanOrEqual(5);
    expect(f.body.blocks[0]!.labels).toEqual(["ok"]);
  });
});

describe(".tf.json and file selection", () => {
  it("parses JSON variables, outputs, modules, required_providers and refs", () => {
    const f = parseTfJson(
      JSON.stringify({
        "//": "comment",
        variable: {
          region: {
            type: "${map(string)}",
            default: { a: "b" },
            description: "R",
            sensitive: true,
            validation: [{}, {}],
          },
        },
        output: [{ out: { value: "${aws_x.y.id}", description: "O" } }],
        module: { m: { source: "./m", version: "1.0.0" } },
        terraform: { required_providers: { aws: { source: "hashicorp/aws", version: "~> 5.0" } } },
        resource: { aws_x: { y: { name: "${data.aws_z.w[0].name}" } } },
      }),
      "main.tf.json",
    );
    const types = f.body.blocks.map((b) => `${b.type}:${b.labels.join(",")}`);
    expect(types).toEqual(["variable:region", "output:out", "module:m", "terraform:", "resource:aws_x,y"]);
    const v = f.body.blocks[0]!;
    expect(v.body.attrs.find((a) => a.name === "type")!.typeText).toBe("map(string)");
    expect(v.body.blocks.filter((b) => b.type === "validation")).toHaveLength(2);
    expect(f.refs.map((r) => r.steps.join("."))).toEqual(
      expect.arrayContaining(["aws_x.y.id", "data.aws_z.w.[].name"]),
    );
    expect(parseTfJson("{broken", "x.tf.json").errors).toEqual([1]);
  });

  it("selects files the way Terraform's loader does", () => {
    expect(isIgnoredFile(".hidden.tf")).toBe(true);
    expect(isIgnoredFile("main.tf~")).toBe(true);
    expect(isIgnoredFile("#main.tf#")).toBe(true);
    expect(isIgnoredFile("main.tf")).toBe(false);
    expect(isOverrideFile("override.tf")).toBe(true);
    expect(isOverrideFile("x_override.tf.json")).toBe(true);
    expect(isOverrideFile("overrides.tf")).toBe(false);
    const dir = tempDir();
    for (const n of ["b.tf", "a.tf.json", "override.tf", "z_override.tf", ".x.tf", "c.tf~", "#d.tf#", "notes.txt"]) {
      writeFileSync(join(dir, n), n.endsWith(".json") ? "{}" : "");
    }
    mkdirSync(join(dir, "sub.tf"));
    expect(moduleFiles(dir)).toEqual({ primary: ["a.tf.json", "b.tf"], override: ["override.tf", "z_override.tf"] });
  });

  it("merges override files attribute-wise", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      `variable "v" {
  type        = string
  description = "orig"
  validation {
    condition     = true
    error_message = "x"
  }
}
output "o" { value = 1 }
module "m" {
  source  = "./a"
  version = "1.0.0"
}
resource "aws_x" "y" {
  name = "a"
  tags = {}
  block { a = 1 }
}
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 4.0" }
  }
}`,
    );
    writeFileSync(
      join(dir, "override.tf"),
      `variable "v" {
  default = "d"
}
output "o" {
  sensitive = true
}
module "m" {
  source = "./b"
}
resource "aws_x" "y" {
  name = "b"
  block { b = 2 }
}
terraform {
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}`,
    );
    const m = await loadModule(dir);
    const v = m.variables.get("v")!;
    expect(v.typeText).toBe("string");
    expect(v.description).toEqual({ kind: "literal", value: "orig" });
    expect(v.default).toEqual({ kind: "literal", value: "d" });
    expect(v.validations).toBe(1);
    expect(m.outputs.get("o")!.sensitive).toBe(true);
    expect(m.moduleCalls.get("m")!.source).toEqual({ kind: "literal", value: "./b" });
    expect(m.moduleCalls.get("m")!.version).toEqual({ kind: "literal", value: "1.0.0" });
    const r = m.resources[0]!;
    expect(
      r.body.attrs.map((a) => `${a.name}=${JSON.stringify(a.value.kind === "literal" ? a.value.value : null)}`),
    ).toEqual(["tags={}", 'name="b"']);
    expect(r.body.blocks.map((b) => b.body.attrs[0]!.name)).toEqual(["b"]);
    expect(m.requiredProviders.get("aws")!.version).toBe("~> 5.0");
  });

  it('keys override nested blocks by generated type (dynamic "x" replaces static x and dynamic "x" only)', async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      `resource "aws_security_group" "g" {
  ingress { from_port = 1 }
  dynamic "ingress" {
    for_each = []
    content { from_port = 2 }
  }
  dynamic "egress" {
    for_each = []
    content { from_port = 3 }
  }
  timeouts { create = "1m" }
}`,
    );
    writeFileSync(
      join(dir, "override.tf"),
      `resource "aws_security_group" "g" {
  dynamic "ingress" {
    for_each = [1]
    content { from_port = 4 }
  }
}`,
    );
    const m = await loadModule(dir);
    const blocks = m.resources[0]!.body.blocks.map((b) => [b.type, ...b.labels].join(":"));
    expect(blocks).toEqual(["dynamic:egress", "timeouts", "dynamic:ingress"]);
  });

  it("resolves providers: meta-argument, required_providers local names, legacy shorthand", async () => {
    const dir = tempDir();
    writeFileSync(
      join(dir, "main.tf"),
      `terraform {
  required_providers {
    rnd    = { source = "hashicorp/random" }
    legacy = "~> 1.0"
    acme   = { source = "example.com/acme/thing", configuration_aliases = [acme.west] }
  }
}
provider "tls" {
  version = "~> 2.0"
}
resource "random_id" "a" { provider = rnd.alias }
resource "thing_x" "b" { provider = acme }
resource "tls_private_key" "c" {}
`,
    );
    const m = await loadModule(dir);
    expect(m.resources.map((r) => resourceProviderSource(m, r))).toEqual([
      "registry.terraform.io/hashicorp/random",
      "example.com/acme/thing",
      "registry.terraform.io/hashicorp/tls",
    ]);
    expect(m.requiredProviders.get("legacy")).toMatchObject({ version: "~> 1.0" });
    expect(m.requiredProviders.get("acme")).toMatchObject({ source: "example.com/acme/thing" });
    expect(m.legacyProviderVersions).toEqual([{ local: "tls", version: "~> 2.0", file: "main.tf", line: 9 }]);
    expect(normalizeProviderSource("HashiCorp/AWS")).toBe("registry.terraform.io/hashicorp/aws");
    expect(normalizeProviderSource("aws")).toBe("registry.terraform.io/hashicorp/aws");
    expect(sameProvider("registry.terraform.io/hashicorp/tls", "registry.opentofu.org/hashicorp/tls")).toBe(true);
    expect(sameProvider("registry.terraform.io/hashicorp/tls", "registry.terraform.io/hashicorp/random")).toBe(false);
    expect(sameProvider("registry.terraform.io/acme/x", "example.com/acme/x")).toBe(false);
  });
});

describe("tf_module_interface", () => {
  it("renders the root", async () => {
    const root = fixtureCopy("modroot");
    expect(await moduleInterface(root, undefined, 160)).toBe(
      [
        "module (root): 1 variables, 4 outputs, 2 module calls",
        "variables:",
        "  db_password: string optional [sensitive] default=(sensitive)",
        "outputs:",
        "  label_id",
        "  new_out",
        "  pet",
        "  pw [sensitive]",
        "module calls:",
        "  label: source=cloudposse/label/null version=0.25.0 -> .terraform/modules/label (installed 0.25.0)",
        "  naming: source=./modules/naming -> modules/naming",
      ].join("\n"),
    );
  });

  it("renders a local module by address and by path identically (types, required, defaults, flags)", async () => {
    const root = fixtureCopy("modroot");
    const expected = [
      "module modules/naming (module.naming): 5 variables, 2 outputs, 0 module calls",
      "variables:",
      "  length: number optional default=2 - Pet name length. Multi-line heredoc description.",
      "  prefix: string required [2 validations] - Name prefix.",
      "  secret_seed: string optional [sensitive] default=(sensitive)",
      "  tags: map(object({value = string, optional = optional(bool, false)})) optional [not nullable] default={}",
      "  untyped: any (no type) required",
      "outputs:",
      "  name - Generated name.",
      "  seed [sensitive]",
    ].join("\n");
    expect(await moduleInterface(root, "module.naming", 160)).toBe(expected);
    expect(await moduleInterface(root, "modules/naming", 160)).toBe(expected);
    expect(await moduleInterface(root, 'module.naming["x"]', 160)).toBe(expected);
  });

  it("renders the CRLF registry module installed under .terraform/modules", async () => {
    const root = fixtureCopy("modroot");
    const out = await moduleInterface(root, "module.label", 0);
    const lines = out.split("\n");
    expect(lines[0]).toBe("module .terraform/modules/label (module.label): 18 variables, 19 outputs, 0 module calls");
    expect(out).toContain(
      '  context: any optional [2 validations] default={"enabled":true,"namespace":null,"tenant":null,"environment":null,"stage":null,"...',
    );
    expect(out).toContain(
      "  label_key_case: string optional [1 validation] default=null - Controls the letter case of the `tags` keys",
    );
    expect(out).not.toMatch(/\r/);
    expect((await moduleInterface(root, "module.label", 20)).split("\n")).toContain(
      "  enabled: bool optional default=null - Set to false to prev...",
    );
  });

  it("redacts credentials in module sources (userinfo, secret query params, secret shapes)", async () => {
    expect(redactModuleSource("git::https://oauth2:FIXTURE-SECRET@gitlab.com/x.git?ref=v1")).toBe(
      "git::https://oauth2:(redacted)@gitlab.com/x.git?ref=v1",
    );
    expect(redactModuleSource("git::https://FIXTURE-SECRET@github.com/x.git")).toBe(
      "git::https://(redacted)@github.com/x.git",
    );
    expect(redactModuleSource("git::ssh://git@github.com/x.git?ref=v1&sshkey=FIXTURE-SECRET")).toBe(
      "git::ssh://git@github.com/x.git?ref=v1&sshkey=(redacted)",
    );
    expect(redactModuleSource("https://b.s3.amazonaws.com/m.zip?X-Amz-Signature=FIXTURE-SECRET&x=1")).toBe(
      "https://b.s3.amazonaws.com/m.zip?X-Amz-Signature=(redacted)&x=1",
    );
    expect(redactModuleSource("git@github.com:org/repo.git//sub?ref=main")).toBe(
      "git@github.com:org/repo.git//sub?ref=main",
    );
    expect(redactModuleSource(`git::https://github.com/ghp_${"a".repeat(36)}/x.git`)).toBe(
      "(redacted: secret-like value)",
    );

    const root = tempDir();
    mkdirSync(join(root, ".terraform", "modules"), { recursive: true });
    writeFileSync(
      join(root, "main.tf"),
      'module "m" {\n  source = "git::https://oauth2:FIXTURE-SECRET@gitlab.com/x.git?sshkey=FIXTURE-plain"\n}\n',
    );
    writeFileSync(
      join(root, ".terraform", "modules", "modules.json"),
      JSON.stringify({
        Modules: [
          { Key: "", Source: "", Dir: "." },
          { Key: "m", Source: "git::https://oauth2:FIXTURE-SECRET@gitlab.com/y.git", Dir: ".terraform/modules/m" },
        ],
      }),
    );
    const out = await moduleInterface(root, undefined, 160);
    expect(out).toContain(
      "  m: source=git::https://oauth2:(redacted)@gitlab.com/x.git?sshkey=(redacted) -> STALE: installed from git::https://oauth2:(redacted)@gitlab.com/y.git, config says git::https://oauth2:(redacted)@gitlab.com/x.git?sshkey=(redacted); run terraform init",
    );
    expect(out).not.toMatch(/FIXTURE-SECRET|FIXTURE-plain/);
  });

  it("reports missing, stale and not-installed module calls", async () => {
    const root = fixtureCopy("modroot");
    const manifest = join(root, ".terraform", "modules", "modules.json");
    writeFileSync(
      manifest,
      JSON.stringify({
        Modules: [
          { Key: "", Source: "", Dir: "." },
          {
            Key: "label",
            Source: "registry.terraform.io/cloudposse/label/null",
            Version: "0.24.1",
            Dir: ".terraform/modules/label",
          },
          { Key: "naming", Source: "./modules/other", Dir: "modules/naming" },
        ],
      }),
    );
    const out = await moduleInterface(root, undefined, 160);
    expect(out).toContain(
      "  label: source=cloudposse/label/null version=0.25.0 -> STALE: installed 0.24.1, config requires 0.25.0; run terraform init",
    );
    expect(out).toContain(
      "  naming: source=./modules/naming -> STALE: installed from ./modules/other, config says ./modules/naming; run terraform init",
    );
    writeFileSync(manifest, JSON.stringify({ Modules: [{ Key: "", Source: "", Dir: "." }] }));
    expect(await moduleInterface(root, undefined, 160)).toContain(
      "  naming: source=./modules/naming -> NOT INSTALLED (run terraform init)",
    );
    await expect(moduleInterface(root, "module.naming", 160)).rejects.toThrow(
      `module.naming is not in .terraform/modules/modules.json (not installed, or not called from ${root}). Run terraform init, or pass a directory path.`,
    );
    // Root and local paths need no init at all.
    expect(await moduleInterface(root, "modules/naming", 160)).toMatch(/^module modules\/naming: 5 variables/);
  });

  it("answers an empty dir as a fact and rejects bad inputs", async () => {
    const root = tempDir();
    expect(await moduleInterface(root, undefined, 160)).toBe(`${root} contains no .tf or .tf.json files.`);
    mkdirSync(join(root, "empty"));
    expect(await moduleInterface(root, "empty", 160)).toBe("empty contains no .tf or .tf.json files.");
    await expect(moduleInterface(root, "missing", 160)).rejects.toThrow(/does not exist or is not a directory/);
    await expect(moduleInterface(join(root, "nope"), undefined, 160)).rejects.toThrow(/does not exist/);
    await expect(moduleInterface(root, "//evil/share", 160)).rejects.toThrow(/UNC or device path/);
  });

  it("redacts secret-like and secret-shaped defaults, shows parse errors and expression defaults", async () => {
    const root = tempDir();
    writeFileSync(
      join(root, "variables.tf"),
      `variable "api_token" {
  default = "plain-but-secret"
}
variable "gh" {
  default = "ghp_${"a".repeat(36)}"
}
variable "computed" {
  type    = list(string)
  default = [for s in ["a"] : upper(s)]
  ephemeral = true
}
variable "long" {
  default = "${"x".repeat(100)}"
  description = <<EOT
  spaced    out
EOT
}
output "o" {
  value     = 1
  ephemeral = true
  description = "Out."
}
variable "broken" {
  type =
`,
    );
    const out = await moduleInterface(root, undefined, 160);
    expect(out).toContain("  api_token: any (no type) optional default=(sensitive)");
    expect(out).toContain("  gh: any (no type) optional default=(redacted: secret-like value)");
    expect(out).toContain('  computed: list(string) optional [ephemeral] default=expr([for s in ["a"] : upper(s)])');
    expect(out).toContain(`  long: any (no type) optional default="${"x".repeat(79)}... - spaced out`);
    expect(out).toContain("  o [ephemeral] - Out.");
    expect(out).toMatch(/parse error: variables\.tf:\d+/);
    expect(out).toContain("terraform validate is the authority");
    expect(out).not.toContain("plain-but-secret");
    expect(out).not.toContain("ghp_");
  });

  it("parses module addresses and normalizes module sources", () => {
    expect(addressToKey("module.a")).toBe("a");
    expect(addressToKey("module.a.module.b")).toBe("a.b");
    expect(addressToKey("module.a[0].module.b")).toBe("a.b");
    expect(addressToKey("modules/a")).toBeNull();
    expect(addressToKey("module.a.b")).toBeNull();
    expect(normalizeModuleSource("cloudposse/label/null")).toBe("registry.terraform.io/cloudposse/label/null");
    expect(normalizeModuleSource("./x")).toBe("./x");
    expect(normalizeModuleSource("git::https://e.com/x.git")).toBe("git::https://e.com/x.git");
    expect(normalizeModuleSource("app.terraform.io/org/name/aws")).toBe("app.terraform.io/org/name/aws");
  });

  // Config source -> the Source terraform init 1.15.7 recorded in modules.json (real values).
  it.each([
    ["../../", "../.."],
    ["../..", "../.."],
    ["./m/", "./m"],
    ["./x/../m", "./m"],
    ["./module/compare", "./module/compare"],
    [".\\m", "./m"],
    ["../", "./.."],
    [
      "github.com/cloudposse/terraform-null-label?ref=0.25.0",
      "git::https://github.com/cloudposse/terraform-null-label.git?ref=0.25.0",
    ],
    [
      "github.com/cloudposse/terraform-null-label//examples/complete?ref=0.25.0",
      "git::https://github.com/cloudposse/terraform-null-label.git//examples/complete?ref=0.25.0",
    ],
    ["github.com/o/r.git", "git::https://github.com/o/r.git"],
    ["bitbucket.org/o/r", "git::https://bitbucket.org/o/r.git"],
    ["git@github.com:o/r.git?ref=x", "git::ssh://git@github.com/o/r.git?ref=x"],
    ["git::https://github.com/o/r.git?ref=x", "git::https://github.com/o/r.git?ref=x"],
    ["cloudposse/label/null", "registry.terraform.io/cloudposse/label/null"],
  ])("normalizes %s like terraform init (%s)", (config, manifest) => {
    expect(normalizeModuleSource(config)).toBe(manifest);
    // Idempotent on the manifest's own form, so both sides compare equal.
    expect(normalizeModuleSource(manifest)).toBe(manifest);
  });

  it("reports no false STALE for sources terraform canonicalized (real modules.json)", async () => {
    const root = tempDir("tfcwd-mod-");
    writeFileSync(
      join(root, "main.tf"),
      [
        'module "up" {\n  source = "../../"\n}',
        'module "slash" {\n  source = "./m/"\n}',
        'module "dots" {\n  source = "./x/../m"\n}',
        'module "gh" {\n  source = "github.com/cloudposse/terraform-null-label?ref=0.25.0"\n}',
        'module "ghsub" {\n  source = "github.com/cloudposse/terraform-null-label//examples/complete?ref=0.25.0"\n}',
        'module "scp" {\n  source = "git@github.com:o/r.git?ref=x"\n}',
        'module "moved" {\n  source = "./elsewhere"\n}',
      ].join("\n"),
    );
    mkdirSync(join(root, ".terraform", "modules"), { recursive: true });
    // Entries as terraform init 1.15.7 wrote them (scp from a reviewer's real init; "moved" is genuinely stale).
    writeFileSync(
      join(root, ".terraform", "modules", "modules.json"),
      JSON.stringify({
        Modules: [
          { Key: "", Source: "", Dir: "." },
          { Key: "dots", Source: "./m", Dir: "m" },
          {
            Key: "gh",
            Source: "git::https://github.com/cloudposse/terraform-null-label.git?ref=0.25.0",
            Dir: ".terraform/modules/gh",
          },
          {
            Key: "ghsub",
            Source: "git::https://github.com/cloudposse/terraform-null-label.git//examples/complete?ref=0.25.0",
            Dir: ".terraform/modules/ghsub/examples/complete",
          },
          { Key: "scp", Source: "git::ssh://git@github.com/o/r.git?ref=x", Dir: ".terraform/modules/scp" },
          { Key: "slash", Source: "./m", Dir: "m" },
          { Key: "up", Source: "../..", Dir: "../.." },
          { Key: "moved", Source: "./m", Dir: "m" },
        ],
      }),
    );
    const out = await moduleInterface(root, undefined, 80);
    expect(out.match(/STALE/g)).toHaveLength(1);
    expect(out).toContain("  moved: source=./elsewhere -> STALE: installed from ./m, config says ./elsewhere");
    expect(out).toContain(
      "  gh: source=github.com/cloudposse/terraform-null-label?ref=0.25.0 -> .terraform/modules/gh",
    );
  });

  it("redacts nested secret keys and inline credentials inside variable defaults", async () => {
    const root = tempDir("tfcwd-mod-");
    writeFileSync(
      join(root, "variables.tf"),
      `variable "db_url" {
  type    = string
  default = "postgres://admin:FIXTURE-hunter2@db.example:5432/app"
}
variable "settings" {
  type    = object({ user = string, password = string })
  default = { user = "admin", password = "FIXTURE-hunter2" }
}
variable "conn" {
  default = ["mysql://root:FIXTURE-pw@h/db"]
}
variable "dsn" {
  default = "Server=db;User Id=sa;Password=FIXTURE-plain-4;"
}
variable "nested" {
  default = { db = { auth = { token = 12345678 } }, region = "us-east-1" }
}
variable "computed_url" {
  default = "\${var.x}postgres://u:FIXTURE-in-expr@h/db"
}
`,
    );
    const out = await moduleInterface(root, undefined, 80);
    expect(out).not.toMatch(/FIXTURE-(hunter2|pw|plain|in-expr)|12345678/);
    expect(out).toContain('  db_url: string optional default="postgres://admin:(redacted)@db.example:5432/app"');
    expect(out).toContain(
      '  settings: object({user = string, password = string}) optional default={"user":"admin","password":"(redacted: secret-like name)"}',
    );
    expect(out).toContain('  conn: any (no type) optional default=["mysql://root:(redacted)@h/db"]');
    expect(out).toContain('  dsn: any (no type) optional default="Server=db;User Id=sa;Password=(redacted);"');
    expect(out).toContain('"region":"us-east-1"');
  });
});

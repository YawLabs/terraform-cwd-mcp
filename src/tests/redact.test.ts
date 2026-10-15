import { describe, expect, it } from "vitest";
import {
  collectSensitiveStrings,
  hasSecretShape,
  isSecretKey,
  maskInlineCredentials,
  maskInlineSecrets,
  maskUrlPasswords,
  REDACTED_NAME,
  REDACTED_SHAPE,
  REDACTED_VALUE,
  Redactor,
  tokenizeKey,
} from "../redact.js";
import { renderResource, type StateDoc, type StateResource, showResource } from "../state.js";
import { readFixtureJson } from "./helpers.js";

const STATE = readFixtureJson<StateDoc>("state/state.json");
const OPTS = { includeNull: false, maxValueChars: 200 };

describe("layer 3: key names", () => {
  it("tokenizes snake, kebab, dotted and camelCase keys", () => {
    expect(tokenizeKey("db_password")).toEqual(["db", "password"]);
    expect(tokenizeKey("clientSecret")).toEqual(["client", "secret"]);
    expect(tokenizeKey("APIKey")).toEqual(["api", "key"]);
    expect(tokenizeKey("x-auth.token")).toEqual(["x", "auth", "token"]);
  });

  it.each([
    "password",
    "db_password",
    "api_token",
    "apiKey",
    "api_key",
    "client_secret",
    "clientSecret",
    "private_key",
    "privateKey",
    "access_key",
    "secret_key",
    "connection_string",
    "connectionString",
    "kubeconfig",
    "passwords",
    "session_cookie",
    "sas",
    "signing_key",
    "password_wo",
    // env-var names with the secret word run together (Lambda / ECS / k8s env maps)
    "PGPASSWORD",
    "ADMINPASSWORD",
    "MYSQLPWD",
    "MYSQL_ROOTPASSWORD",
    "GITHUBTOKEN",
    "STRIPEAPIKEY",
    "JWTSECRET",
  ])("%s is secret", (k) => expect(isSecretKey(k)).toBe(true));

  it.each([
    "password_length",
    "secret_arn",
    "token_ttl",
    "key_algorithm",
    "public_key_pem",
    "public_key_fingerprint_md5",
    "password_policy",
    "secret_name",
    "kms_key_id",
    "note",
    "name",
    "key",
    "content_sha256",
    "password_wo_version",
    "secretsmanager",
    "PGPASSWORD_FILE",
    "tokenizer",
  ])("%s is not secret", (k) => expect(isSecretKey(k)).toBe(false));
});

describe("layer 4: value shapes", () => {
  it.each([
    "-----BEGIN RSA PRIVATE KEY-----\nabc",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----",
    "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    `ghp_${"a".repeat(36)}`,
    `github_pat_${"a1".repeat(20)}`,
    `glpat-${"x".repeat(20)}`,
    "xoxb-1234567890-abcdefghij",
    `npm_${"A".repeat(36)}`,
    `sk-ant-${"a".repeat(30)}`,
    `AIza${"b".repeat(35)}`,
    // base64 of PEM private keys, as kubeconfig client-key-data holds them (all three alignments)
    Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nMIIE").toString("base64"),
    Buffer.from("-----BEGIN PRIVATE KEY-----\nMIIE").toString("base64"),
    Buffer.from("-----BEGIN EC PRIVATE KEY-----\nMHc").toString("base64"),
    Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nb3B").toString("base64"),
    `client-key-data: ${Buffer.from("-----BEGIN RSA PRIVATE KEY-").toString("base64")}`,
  ])("redacts %s", (s) => expect(hasSecretShape(s)).toBe(true));

  it.each([
    "-----BEGIN PUBLIC KEY-----\nabc",
    "ghp_short",
    "plain text",
    "sk-1",
    Buffer.from("-----BEGIN CERTIFICATE-----\nMIID").toString("base64"),
    Buffer.from("-----BEGIN PUBLIC KEY-----\nMIIB").toString("base64"),
  ])("keeps %s", (s) => expect(hasSecretShape(s)).toBe(false));

  it("masks only the password of a URL with userinfo", () => {
    expect(maskUrlPasswords("postgres://app:hunter2@db:5432/x")).toBe("postgres://app:(redacted)@db:5432/x");
    expect(maskUrlPasswords("see https://u:p@h and redis://a:b@c")).toBe(
      "see https://u:(redacted)@h and redis://a:(redacted)@c",
    );
    expect(maskUrlPasswords("https://user@host/path")).toBeNull();
    expect(maskUrlPasswords("https://host/path")).toBeNull();
  });

  it("masks inline key=value credentials in connection strings, command lines and JSON", () => {
    expect(maskInlineCredentials("Server=db;User Id=sa;Password=FIXTURE-plain-4;")).toBe(
      "Server=db;User Id=sa;Password=(redacted);",
    );
    expect(maskInlineCredentials("mysql --password=FIXTURE-plain-5 -h db")).toBe("mysql --password=(redacted) -h db");
    expect(maskInlineCredentials('{"token": "FIXTURE-plain-6", "user": "a"}')).toBe(
      '{"token": "(redacted)", "user": "a"}',
    );
    expect(
      maskInlineCredentials(
        "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=FIXTURE-plain-7==;EndpointSuffix=x",
      ),
    ).toBe("DefaultEndpointsProtocol=https;AccountName=a;AccountKey=(redacted);EndpointSuffix=x");
    expect(maskInlineCredentials("aws_secret_access_key=FIXTURE-plain-8")).toBe("aws_secret_access_key=(redacted)");
    expect(maskInlineCredentials("https://h/cb?token=FIXTURE-plain-9&x=1")).toBe("https://h/cb?token=(redacted)&x=1");
    expect(maskInlineCredentials("password_length=16")).toBeNull();
    expect(maskInlineCredentials("secretsmanager:GetSecretValue")).toBeNull();
    expect(maskInlineCredentials("plain text")).toBeNull();
    expect(maskInlineSecrets("postgres://u:FIXTURE-plain-1@h/db?password=FIXTURE-plain-2")).toBe(
      "postgres://u:(redacted)@h/db?password=(redacted)",
    );
  });
});

describe("layer 2: the document-wide sensitive set", () => {
  it("collects marked strings from every resource and module, plus sensitive outputs", () => {
    const set = collectSensitiveStrings(STATE);
    expect(set.has("FIXTURE-SECRET-15")).toBe(true); // terraform_data.cfg input.pw
    expect(set.has("FIXTURE-SECRET-13")).toBe(true); // output pw
    expect(set.has("not a secret")).toBe(false);
  });

  it("collects from plan before/after, outputs and sensitive variables", () => {
    const plan = readFixtureJson("plan/plan.json");
    const set = collectSensitiveStrings(plan);
    expect(set.has("FIXTURE-SECRET-12")).toBe(true); // output_changes.pw.before
    expect(set.has("FIXTURE-SECRET-15")).toBe(true); // variables.db_password
  });

  it("matches equality and >= 8-char containment, ignores short secrets and non-strings", () => {
    const r = new Redactor(new Set(["abcd", "longsecretvalue"]));
    expect(r.matchesSensitive("abcd")).toBe(true);
    expect(r.matchesSensitive("xxabcdxx")).toBe(false); // too short to match by containment
    expect(r.matchesSensitive("prefix-longsecretvalue-suffix")).toBe(true);
    expect(collectSensitiveStrings(null).size).toBe(0);
    // Strings under 4 chars, numbers under 4 digits and bools never enter the set.
    const tiny = collectSensitiveStrings({
      values: {
        root_module: {
          resources: [
            {
              values: { a: "abc", n: 123, b: true, big: 12345 },
              sensitive_values: { a: true, n: true, b: true, big: true },
            },
          ],
        },
      },
    });
    expect([...tiny]).toEqual(["12345"]);
  });

  it("applies the layers in order and counts each", () => {
    const r = new Redactor(new Set(["FIXTURE-SECRET-01"]));
    expect(r.redactString("FIXTURE-SECRET-01", ["password"])).toEqual({ replaced: REDACTED_VALUE });
    expect(r.redactString("x", ["db_password"])).toEqual({ replaced: REDACTED_NAME });
    expect(r.redactString(`ghp_${"z".repeat(36)}`, ["note"])).toEqual({ replaced: REDACTED_SHAPE });
    expect(r.redactString("postgres://a:b@h", ["url"])).toEqual({ value: "postgres://a:(redacted)@h" });
    expect(r.redactString("fine", ["note"])).toEqual({ value: "fine" });
    expect(r.counts).toEqual({ marked: 0, name: 1, value: 1, shape: 2 });
    expect(r.footer()).toBe("redacted: 0 marked sensitive by Terraform, 1 by name, 1 by value, 2 by shape");
    expect(new Redactor(new Set()).footer()).toBe("");
  });
});

describe("tf_show_resource rendering on the real fixture state", () => {
  it("renders terraform_data.cfg: marker + value match (output.pw has no marker)", () => {
    expect(showResource(STATE, "terraform_data.cfg", OPTS)).toBe(
      [
        "terraform_data.cfg (terraform_data, terraform.io/builtin/terraform, schema v0)",
        '  id = "d085f8d4-9c26-759a-8d47-dad5b7cf50f2"',
        "  input.pw = (sensitive)",
        '  input.version = "2"',
        "  output.pw = (redacted: contains a sensitive value)",
        '  output.version = "2"',
        "redacted: 1 marked sensitive by Terraform, 0 by name, 1 by value",
      ].join("\n"),
    );
  });

  it("renders terraform_data.with_token: unmarked literal secrets caught by name", () => {
    expect(showResource(STATE, "terraform_data.with_token", OPTS)).toBe(
      [
        "terraform_data.with_token (terraform_data, terraform.io/builtin/terraform, schema v0)",
        '  id = "442caadd-37d2-988f-71f2-b4496c7a435d"',
        "  input.api_token = (redacted: secret-like name)",
        "  input.db_password = (redacted: secret-like name)",
        '  input.note = "not a secret"',
        "  output.api_token = (redacted: secret-like name)",
        "  output.db_password = (redacted: secret-like name)",
        '  output.note = "not a secret"',
        "redacted: 0 marked sensitive by Terraform, 4 by name, 0 by value",
      ].join("\n"),
    );
  });

  it("renders tls_private_key.k with truncation that keeps the closing quote", () => {
    const out = showResource(STATE, "tls_private_key.k", OPTS);
    expect(out.split("\n")[0]).toBe("tls_private_key.k (tls_private_key, hashicorp/tls, schema v1)");
    expect(out).toContain("  private_key_pem = (sensitive)");
    expect(out).toContain('  public_key_fingerprint_md5 = "83:74:49:ec:b2:9c:a5:d4:ad:a1:7b:4c:0d:05:77:42"');
    expect(out).toMatch(/ {2}public_key_openssh = "ecdsa-sha2-nistp384 [^"]{180,}" \.\.\. \(\+5 chars\)/);
    expect(out).toContain("  rsa_bits = 2048");
    expect(out.split("\n").pop()).toBe("redacted: 3 marked sensitive by Terraform, 0 by name, 0 by value");
    expect(showResource(STATE, "tls_private_key.k", { ...OPTS, maxValueChars: 0 })).not.toContain("(+");
  });

  it("every resource in the fixture renders with zero sentinel strings", () => {
    const addresses: string[] = [];
    const visit = (m: { resources?: { address: string }[]; child_modules?: unknown[] } | undefined) => {
      for (const r of m?.resources ?? []) addresses.push(r.address);
      for (const c of (m?.child_modules ?? []) as (typeof m)[]) visit(c);
    };
    visit(STATE.values?.root_module as never);
    expect(addresses).toHaveLength(15);
    for (const a of addresses) {
      const out = showResource(STATE, a, { includeNull: true, maxValueChars: 0 });
      expect(out, a).not.toMatch(/FIXTURE-SECRET|FIXTURE-plain/);
    }
  });

  it("lists instances for a bare count/for_each address, and says when an address is absent", () => {
    expect(showResource(STATE, "random_integer.n", OPTS)).toBe(
      "random_integer.n has 2 instances; pass one: random_integer.n[0], random_integer.n[1]",
    );
    expect(showResource(STATE, 'random_password.per_env["dev"]', OPTS)).toContain("result = (sensitive)");
    expect(showResource(STATE, "module.naming.random_pet.this", OPTS)).toContain(
      "module.naming.random_pet.this (random_pet",
    );
    expect(showResource(STATE, "nope.nope", OPTS)).toBe(
      "nope.nope is not in state. Use tf_state_addresses to list addresses.",
    );
  });

  it("renders a data source header and hides nulls unless asked", () => {
    const out = showResource(STATE, "data.local_sensitive_file.read", OPTS);
    expect(out.split("\n")[0]).toBe(
      "data.local_sensitive_file.read (data local_sensitive_file, hashicorp/local, schema v0)",
    );
    const res: StateResource = {
      address: "x_y.z",
      type: "x_y",
      provider_name: "registry.terraform.io/acme/x",
      values: { a: null, tags: { Name: "web", "with space": "v" }, list: [], obj: {}, flag: false },
      deposed_key: "abc",
      tainted: true,
    };
    expect(renderResource(res, new Set(), OPTS)).toBe(
      [
        "x_y.z [deposed abc] [tainted] (x_y, acme/x, schema v0)",
        "  flag = false",
        "  list = []",
        "  obj = {}",
        '  tags["Name"] = "web"',
        '  tags["with space"] = "v"',
      ].join("\n"),
    );
    expect(renderResource(res, new Set(), { ...OPTS, includeNull: true })).toContain("  a = null");
  });

  it("redacts nested and list values: marker subtrees, list elements, ancestor names", () => {
    const res: StateResource = {
      address: "x_y.n",
      type: "x_y",
      values: {
        settings: { inner: { deep: "FIXTURE-SECRET-77", ok: "visible" } },
        list: ["a-visible", "FIXTURE-SECRET-77-and-more"],
        credentials: { client_id: "cid-123", nested: ["v1"] },
        whole: { k1: "FIXTURE-SECRET-78", k2: "FIXTURE-SECRET-79" },
        num_password: 42,
      },
      sensitive_values: { settings: { inner: { deep: true } }, whole: true },
    };
    const out = renderResource(res, collectSensitiveStrings({ values: { root_module: { resources: [res] } } }), OPTS);
    expect(out).toBe(
      [
        "x_y.n (x_y, ?, schema v0)",
        "  credentials.client_id = (redacted: secret-like name)",
        "  credentials.nested[0] = (redacted: secret-like name)",
        '  list[0] = "a-visible"',
        "  list[1] = (redacted: contains a sensitive value)",
        "  num_password = (redacted: secret-like name)",
        "  settings.inner.deep = (sensitive)",
        '  settings.inner.ok = "visible"',
        "  whole = (sensitive)",
        "redacted: 2 marked sensitive by Terraform, 3 by name, 1 by value",
      ].join("\n"),
    );
    // A marked map's keys are not printed either.
    expect(out).not.toContain("k1");
  });

  it("redacts number and bool leaves by name and by marked value (real terraform_data shapes)", () => {
    // var.num (sensitive, 987654321) as terraform_data input.n: terraform marks input.n but not output.n;
    // input = { password = 12345678, pin = 123456 } carries no marker at all.
    const res: StateResource = {
      address: "terraform_data.n",
      type: "terraform_data",
      provider_name: "terraform.io/builtin/terraform",
      values: {
        input: { n: 987654321, password: 12345678, pin: 123456, count: 3, enabled: true },
        output: { n: 987654321, password: 12345678, pin: 123456, count: 3, enabled: true },
      },
      sensitive_values: { input: { n: true }, output: {} },
    };
    const out = renderResource(res, collectSensitiveStrings({ values: { root_module: { resources: [res] } } }), OPTS);
    expect(out).not.toMatch(/987654321|12345678|123456/);
    expect(out).toContain("  input.n = (sensitive)");
    expect(out).toContain("  output.n = (redacted: contains a sensitive value)");
    expect(out).toContain("  output.password = (redacted: secret-like name)");
    expect(out).toContain("  output.pin = (redacted: secret-like name)");
    expect(out).toContain("  output.count = 3");
    expect(out).toContain("  output.enabled = true");
    expect(out).toContain("redacted: 1 marked sensitive by Terraform, 4 by name, 1 by value");
  });

  it("redacts run-together env-var names, inline credentials and base64 keys (real fixture shapes)", () => {
    const res: StateResource = {
      address: "terraform_data.env",
      type: "terraform_data",
      values: {
        input: {
          variables: {
            PGPASSWORD: "FIXTURE-plain-1",
            ADMINPASSWORD: "FIXTURE-plain-2",
            MYSQLPWD: "FIXTURE-plain-3",
            DSN: "Server=db;User Id=sa;Password=FIXTURE-plain-4;",
            CMD: "mysql --password=FIXTURE-plain-5 -h db",
            KUBECONFIG_DATA: `client-key-data: ${Buffer.from("-----BEGIN RSA PRIVATE KEY-----").toString("base64")}`,
            REGION: "us-east-1",
          },
        },
      },
    };
    const out = renderResource(res, new Set(), OPTS);
    expect(out).not.toContain("FIXTURE-plain");
    expect(out).not.toContain("LS0tLS1CRUdJTi");
    expect(out).toContain('  input.variables["DSN"] = "Server=db;User Id=sa;Password=(redacted);"');
    expect(out).toContain('  input.variables["CMD"] = "mysql --password=(redacted) -h db"');
    expect(out).toContain('  input.variables["REGION"] = "us-east-1"');
  });
});

import { describe, expect, it } from "vitest";
import { checkArguments, fmtType, getSchema, listProviders, searchTypes } from "../format.js";
import type { SchemaDump } from "../schema.js";
import { FIXTURE, FIXTURE_VERSIONS } from "./helpers.js";

const RANDOM = "registry.terraform.io/hashicorp/random";

/** Hand-built dump for shapes the random/tls fixture does not carry. */
const SYNTHETIC: SchemaDump = {
  format_version: "1.0",
  provider_schemas: {
    "registry.terraform.io/acme/demo": {
      resource_schemas: {
        demo_thing: {
          block: {
            attributes: {
              name: { type: "string", required: true },
              settings: {
                nested_type: {
                  nesting_mode: "single",
                  attributes: {
                    mode: { type: "string", optional: true },
                    legacy: { type: "bool", optional: true, deprecated: true },
                    status: { type: "string", computed: true },
                  },
                },
                optional: true,
              },
              observed: {
                nested_type: { nesting_mode: "list", attributes: { value: { type: "string", computed: true } } },
                computed: true,
              },
            },
            block_types: {
              old_rule: {
                nesting_mode: "set",
                min_items: 1,
                max_items: 3,
                block: { deprecated: true, attributes: { port: { type: "number", required: true } } },
              },
              outer: {
                nesting_mode: "list",
                block: {
                  block_types: {
                    middle: {
                      nesting_mode: "list",
                      block: {
                        block_types: {
                          inner: {
                            nesting_mode: "single",
                            block: { attributes: { leaf: { type: "string", optional: true } } },
                          },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        demo_retired: { block: { deprecated: true, attributes: { id: { type: "string", computed: true } } } },
      },
    },
  },
};

describe("listProviders", () => {
  it("lists every provider with its pinned version and per-kind counts", () => {
    expect(listProviders(FIXTURE, FIXTURE_VERSIONS)).toBe(
      [
        "registry.terraform.io/hashicorp/random 3.9.1 (10 resource, 0 data, 2 ephemeral)",
        "registry.terraform.io/hashicorp/tls 4.4.1 (4 resource, 2 data, 2 ephemeral)",
      ].join("\n"),
    );
  });

  it("prints ? for a provider missing from the lock file", () => {
    expect(listProviders(FIXTURE, {})).toContain(`${RANDOM} ? (`);
  });

  it("says so when there are no providers", () => {
    expect(listProviders({}, {})).toBe("no providers");
  });
});

describe("searchTypes", () => {
  it("matches case-insensitive substrings, sorted", () => {
    expect(searchTypes(FIXTURE, "UUID", "resource", 50)).toBe("random_uuid\nrandom_uuid4\nrandom_uuid7");
  });

  it("truncates at limit with a narrow-the-query hint", () => {
    expect(searchTypes(FIXTURE, "uuid", "resource", 2)).toBe("random_uuid\nrandom_uuid4\n... 1 more, narrow the query");
  });

  it("searches data sources and ephemeral resources by kind", () => {
    expect(searchTypes(FIXTURE, "public", "data", 50)).toBe("tls_public_key");
    expect(searchTypes(FIXTURE, "", "ephemeral", 50)).toBe(
      "random_bytes\nrandom_password\ntls_private_key\ntls_public_key",
    );
  });

  it("reports no match per kind", () => {
    expect(searchTypes(FIXTURE, "s3_bucket", "resource", 50)).toBe("no resource types match 's3_bucket'");
    expect(searchTypes(FIXTURE, "uuid", "data", 50)).toBe("no data types match 'uuid'");
  });
});

describe("getSchema", () => {
  const pw = getSchema(FIXTURE, FIXTURE_VERSIONS, "random_password", "resource", 3, 160).split("\n");

  it("heads with kind, type, provider and pinned version", () => {
    expect(pw[0]).toBe(`resource random_password (${RANDOM} 3.9.1)`);
  });

  it("labels required, optional+computed, read-only, deprecated and sensitive attributes", () => {
    expect(pw).toContain(
      "  length: number required - The length of the password desired. The minimum value for length is 1 and, length must also be >= (`min_upper` + `min_lower` + `min_numeric` + `min_special`).",
    );
    expect(pw).toContain("  result: string computed (read-only) [sensitive] - The generated random password.");
    expect(pw.find((l) => l.startsWith("  number:"))).toMatch(/^ {2}number: bool optional\+computed \[deprecated\] - /);
    expect(pw.find((l) => l.startsWith("  keepers:"))).toMatch(/^ {2}keepers: \["map","string"\] optional - /);
  });

  it("sorts attributes by name", () => {
    const names = pw.slice(1).map((l) => l.trim().split(":")[0]);
    expect(names).toEqual([...names].sort());
  });

  it("truncates descriptions to description_chars, and 0 means no limit", () => {
    const short = getSchema(FIXTURE, FIXTURE_VERSIONS, "random_password", "resource", 3, 10);
    expect(short).toContain("  length: number required - The length...");
    const full = getSchema(FIXTURE, FIXTURE_VERSIONS, "random_shuffle", "resource", 3, 0);
    expect(full).toContain("**Important:** Even with an identical seed");
    expect(full).not.toContain("...");
  });

  it("flags write_only and renders nested blocks with cardinality", () => {
    const cert = getSchema(FIXTURE, FIXTURE_VERSIONS, "tls_self_signed_cert", "resource", 3, 0).split("\n");
    expect(cert.find((l) => l.startsWith("  private_key_pem_wo:"))).toMatch(
      /^ {2}private_key_pem_wo: string optional \[sensitive\] \[write_only\] - /,
    );
    expect(cert).toContain("  subject { block, list, min 0 }");
    expect(cert).toContain("    common_name: string optional - Distinguished name: `CN`");
  });

  it("collapses blocks below max_depth", () => {
    const cert = getSchema(FIXTURE, FIXTURE_VERSIONS, "tls_self_signed_cert", "resource", 1, 0).split("\n");
    const i = cert.indexOf("  subject { block, list, min 0 }");
    expect(cert[i + 1]).toBe("    ... (raise max_depth to expand)");
    expect(cert.join("\n")).not.toContain("common_name");
  });

  it("renders complex types as compact JSON", () => {
    const cert = getSchema(FIXTURE, FIXTURE_VERSIONS, "tls_certificate", "data", 3, 0);
    expect(cert).toMatch(/^data tls_certificate \(registry\.terraform\.io\/hashicorp\/tls 4\.4\.1\)/);
    expect(cert).toContain('  certificates: ["list",["object",{"cert_pem":"string"');
  });

  it("answers for ephemeral resources", () => {
    expect(getSchema(FIXTURE, FIXTURE_VERSIONS, "tls_private_key", "ephemeral", 3, 160)).toMatch(
      /^ephemeral tls_private_key \(registry\.terraform\.io\/hashicorp\/tls 4\.4\.1\)\n {2}algorithm: string required/,
    );
  });

  it("names a missing type and points at tf_search_types", () => {
    expect(getSchema(FIXTURE, FIXTURE_VERSIONS, "aws_s3_bucket", "resource", 3, 160)).toBe(
      "resource 'aws_s3_bucket' does not exist in the pinned providers. Use tf_search_types to find the right name.",
    );
    // Exists as a resource, not as a data source.
    expect(getSchema(FIXTURE, FIXTURE_VERSIONS, "random_password", "data", 3, 160)).toMatch(
      /^data 'random_password' does not exist/,
    );
  });

  it("marks deprecated types and blocks, and expands nested attributes", () => {
    expect(getSchema(SYNTHETIC, {}, "demo_retired", "resource", 3, 0).split("\n")[0]).toBe(
      "resource demo_retired (registry.terraform.io/acme/demo ?) [DEPRECATED]",
    );
    const thing = getSchema(SYNTHETIC, {}, "demo_thing", "resource", 3, 0).split("\n");
    expect(thing).toContain("  old_rule { block, set, min 1, max 3 [deprecated] }");
    expect(thing).toContain("  settings: nested:single optional");
    expect(thing).toContain("    legacy: bool optional [deprecated]");
    expect(thing).toContain("    status: string computed (read-only)");
    expect(thing).toContain("  observed: nested:list computed (read-only)");
  });

  it("stops expanding three-deep blocks at the default max_depth", () => {
    const thing = getSchema(SYNTHETIC, {}, "demo_thing", "resource", 3, 0).split("\n");
    expect(thing).toContain("      inner { block, single, min 0 }");
    expect(thing).toContain("        ... (raise max_depth to expand)");
    const deeper = getSchema(SYNTHETIC, {}, "demo_thing", "resource", 4, 0);
    expect(deeper).toContain("        leaf: string optional");
  });
});

describe("checkArguments", () => {
  it("flags ok, read-only, deprecated, unknown and attribute-as-block paths", () => {
    expect(
      checkArguments(FIXTURE, "random_password", ["length", "result", "number", "bogus", "length.x"], "resource"),
    ).toBe(
      [
        "length: ok",
        "result: READ-ONLY (computed) - cannot be set",
        "number: ok [deprecated]",
        "bogus: UNKNOWN - 'bogus' does not exist here",
        "length.x: 'length' is an attribute, not a block",
      ].join("\n"),
    );
  });

  it("walks nested blocks", () => {
    expect(
      checkArguments(
        FIXTURE,
        "tls_self_signed_cert",
        ["subject", "subject.common_name", "subject.nope", "nope.common_name"],
        "resource",
      ),
    ).toBe(
      [
        "subject: ok (block)",
        "subject.common_name: ok",
        "subject.nope: UNKNOWN - 'nope' does not exist here",
        "nope.common_name: UNKNOWN - 'nope' does not exist here",
      ].join("\n"),
    );
  });

  it("walks nested attributes and flags deprecated blocks", () => {
    expect(
      checkArguments(
        SYNTHETIC,
        "demo_thing",
        [
          "settings",
          "settings.mode",
          "settings.legacy",
          "settings.status",
          "settings.nope",
          "observed.value",
          "old_rule",
          "old_rule.port",
          "outer.middle.inner.leaf",
          "",
        ],
        "resource",
      ),
    ).toBe(
      [
        "settings: ok",
        "settings.mode: ok",
        "settings.legacy: ok [deprecated]",
        "settings.status: READ-ONLY (computed) - cannot be set",
        "settings.nope: UNKNOWN - 'nope' does not exist here",
        "observed.value: READ-ONLY (computed) - 'observed' cannot be set",
        "old_rule: ok (block) [deprecated]",
        "old_rule.port: ok",
        "outer.middle.inner.leaf: ok",
        ": UNKNOWN - '' does not exist here",
      ].join("\n"),
    );
  });

  it("does not treat inherited object keys as attributes", () => {
    expect(checkArguments(FIXTURE, "random_password", ["constructor", "toString"], "resource")).toBe(
      "constructor: UNKNOWN - 'constructor' does not exist here\ntoString: UNKNOWN - 'toString' does not exist here",
    );
  });

  it("reports a missing type", () => {
    expect(checkArguments(FIXTURE, "random_nope", ["x"], "resource")).toBe(
      "resource 'random_nope' does not exist in the pinned providers.",
    );
  });
});

describe("fmtType", () => {
  it("passes primitive types through and JSON-encodes the rest", () => {
    expect(fmtType("string")).toBe("string");
    expect(fmtType(["set", "number"])).toBe('["set","number"]');
  });
});

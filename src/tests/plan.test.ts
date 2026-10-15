import { describe, expect, it } from "vitest";
import {
  detectPlanJson,
  isZip,
  type PlanDoc,
  planShowErrorMessage,
  type ResourceChange,
  STATE_MESSAGE,
  summarizePlan,
  UI_STREAM_MESSAGE,
} from "../plan.js";
import { readFixture, readFixtureJson } from "./helpers.js";

const OPTS = { maxPerSection: 50, maxPaths: 8 };
const PLAN_TEXT = readFixture("plan/plan.json");
const PLAN = JSON.parse(PLAN_TEXT) as PlanDoc;

/** Every sentinel the fixtures use in place of a real secret, plus the import ID (which IS a secret for random_id). */
function expectNoSecrets(out: string): void {
  expect(out).not.toMatch(/FIXTURE-SECRET|FIXTURE-plain/);
  expect(out).not.toContain("p-9hUg");
}

const rc = (
  address: string,
  actions: string[],
  extra: Partial<ResourceChange> = {},
  change: object = {},
): ResourceChange => ({
  address,
  mode: "managed",
  type: address.replace(/^module\.[^.]+\./, "").split(".")[0],
  name: address.split(".").pop(),
  ...extra,
  change: { actions, before: null, after: null, ...change },
});

describe("summarizePlan on the real fixture plan", () => {
  it("renders the exact summary (cross-checked against terraform's own CLI text)", () => {
    expect(summarizePlan(PLAN, OPTS)).toBe(
      [
        "plan (terraform 1.15.7, format 1.2): applyable, complete",
        "totals: 1 delete, 5 replace, 1 update, 1 create, 0 read, 1 import, 1 move, 1 forget, 0 unchanged (terraform: 1 to import, 6 to add, 1 to change, 6 to destroy)",
        "DELETE (1)",
        "  - null_resource.gone (not in configuration)",
        "REPLACE (5)",
        "  -/+ local_sensitive_file.sf delete-then-create; forced by: content [sensitive]",
        "  -/+ random_password.db delete-then-create; forced by: length",
        "  +/- random_string.cbd create-before-destroy; forced by: keepers",
        "  -/+ tls_private_key.k delete-then-create; forced by: ecdsa_curve",
        "  -/+ module.naming.random_pet.this delete-then-create; forced by: prefix",
        "UPDATE (1)",
        "  ~ terraform_data.cfg: input.version, output (known after apply)",
        "CREATE (1)",
        "  + local_file.drift",
        "IMPORT (1)",
        "  random_id.imp",
        "MOVED (1)",
        "  random_pet.a -> random_pet.renamed",
        "FORGET (1)",
        "  . random_id.keep (removed from state, object NOT destroyed)",
        "DRIFT (detected during refresh) (1)",
        "  local_file.drift: deleted outside Terraform",
        "OUTPUTS (2)",
        "  + new_out",
        "  ~ pw [sensitive] (known after apply)",
        "WARNING: 6 object(s) will be destroyed (1 delete, 5 replace). 1 moved block(s) applied; none covers these.",
      ].join("\n"),
    );
  });

  it("never prints a sensitive value, the import ID or an output value", () => {
    const out = summarizePlan(PLAN, OPTS);
    expectNoSecrets(out);
    // output values from the fixture: "added", "eg-app", "delicate-pangolin"
    expect(out).not.toMatch(/eg-app|delicate-pangolin|"added"/);
  });
});

describe("summarizePlan on hand-built plans", () => {
  const base = (changes: ResourceChange[], extra: Partial<PlanDoc> = {}): PlanDoc => ({
    format_version: "1.2",
    terraform_version: "1.15.7",
    applyable: true,
    complete: true,
    errored: false,
    resource_changes: changes,
    ...extra,
  });

  it("maps every replace reason", () => {
    const out = summarizePlan(
      base([
        rc("a_x.tainted", ["delete", "create"], { action_reason: "replace_because_tainted" }),
        rc("a_x.req", ["create", "delete"], { action_reason: "replace_by_request" }),
        rc("a_x.trig", ["delete", "create"], { action_reason: "replace_by_triggers" }),
        rc("a_x.none", ["delete", "create"]),
      ]),
      OPTS,
    );
    expect(out).toContain("  -/+ a_x.tainted delete-then-create; tainted");
    expect(out).toContain("  +/- a_x.req create-before-destroy; -replace requested");
    expect(out).toContain("  -/+ a_x.trig delete-then-create; replace_triggered_by");
    expect(out).toContain("  -/+ a_x.none delete-then-create\n");
    expect(out).toContain("(terraform: 4 to add, 0 to change, 4 to destroy)");
  });

  it("truncates replace paths that pass through a sensitive map and hides its keys", () => {
    const out = summarizePlan(
      base([
        rc(
          "a_x.s",
          ["delete", "create"],
          { action_reason: "replace_because_cannot_update" },
          {
            replace_paths: [
              ["keepers", "secret-key-name"],
              ["tags", "Name"],
              ["list", 0, "x"],
            ],
            before_sensitive: { keepers: true },
            after_sensitive: { keepers: true },
          },
        ),
      ]),
      OPTS,
    );
    expect(out).toContain("forced by: keepers [sensitive], tags.Name, list[0].x");
    expect(out).not.toContain("secret-key-name");
  });

  it("lists update paths: nested, list elements, unknown, sensitive (path only) and max_paths", () => {
    const change = {
      before: { a: 1, nested: { b: "x", c: "same" }, list: ["p", "q"], secret: "FIXTURE-SECRET-99", m: { k1: 1 } },
      after: { a: 2, nested: { b: "y", c: "same" }, list: ["p", "r", "s"], secret: "FIXTURE-SECRET-98", m: { k1: 1 } },
      after_unknown: { computed: true },
      before_sensitive: { secret: true },
      after_sensitive: { secret: true },
    };
    const out = summarizePlan(base([rc("a_x.u", ["update"], {}, change)]), OPTS);
    // A length change is reported once for the list, with multiset counts (indexes shift).
    expect(out).toContain(
      "  ~ a_x.u: a, computed (known after apply), list (2 added, 1 removed), nested.b, secret [sensitive]",
    );
    expectNoSecrets(out);
    const capped = summarizePlan(base([rc("a_x.u", ["update"], {}, change)]), { ...OPTS, maxPaths: 2 });
    expect(capped).toContain("  ~ a_x.u: a, computed (known after apply), ... +3 more");
  });

  it("reports a set losing an element once, not every shifted index (real plan shape)", () => {
    // terraform_data input = toset(["a","b","c"]) -> toset(["b","c"]): terraform shows only `- "a"`.
    const shrink = {
      before: { input: { s: ["a", "b", "c"] } },
      after: { input: { s: ["b", "c"] } },
      after_unknown: { output: true },
      before_sensitive: { input: { s: [false, false, false] } },
      after_sensitive: { input: { s: [false, false] } },
    };
    const out = summarizePlan(base([rc("terraform_data.s", ["update"], {}, shrink)]), OPTS);
    expect(out).toContain("  ~ terraform_data.s: input.s (1 removed), output (known after apply)");
    expect(out).not.toContain("input.s[0]");
    // Same length: still per index.
    const same = {
      before: { l: ["p", "q"] },
      after: { l: ["p", "r"] },
      after_unknown: {},
      before_sensitive: {},
      after_sensitive: {},
    };
    expect(summarizePlan(base([rc("x_y.z", ["update"], {}, same)]), OPTS)).toContain("  ~ x_y.z: l[1]");
    // A sensitive list: only the counts, never the elements.
    const secret = {
      before: { k: ["FIXTURE-SECRET-1"] },
      after: { k: ["FIXTURE-SECRET-1", "FIXTURE-SECRET-2"] },
      after_unknown: {},
      before_sensitive: { k: [true] },
      after_sensitive: { k: [true, true] },
    };
    const s = summarizePlan(base([rc("x_y.k", ["update"], {}, secret)]), OPTS);
    expect(s).toContain("  ~ x_y.k: k (1 added)");
    expectNoSecrets(s);
  });

  it("handles read, forget, create-then-forget, deposed and unknown action lists", () => {
    const out = summarizePlan(
      base([
        rc("data.a_d.r", ["read"], { mode: "data", action_reason: "read_because_config_unknown" }),
        rc("data.a_d.p", ["read"], { mode: "data", action_reason: "read_because_dependency_pending" }),
        rc("a_x.f", ["create", "forget"]),
        rc("a_x.dep", ["delete"], { deposed: "00000001" }),
        rc("a_x.weird", ["frobnicate"]),
        rc("data.a_d.gone", ["delete"], { mode: "data" }),
      ]),
      OPTS,
    );
    expect(out).toContain(
      "READ (2)\n  <= data.a_d.r (configuration depends on values known after apply)\n  <= data.a_d.p (depends on a pending change)",
    );
    expect(out).toContain("  +. a_x.f (new object created; the previous object is removed from state, NOT destroyed)");
    expect(out).toContain("  - a_x.dep (deposed object 00000001)");
    expect(out).toContain("  ? a_x.weird (unrecognized actions: frobnicate)");
    // A deleted data source is not rendered or counted, like terraform's own output.
    expect(out).not.toContain("a_d.gone");
    // create,forget is not counted in terraform's "to add".
    expect(out).toContain("(terraform: 0 to add, 0 to change, 1 to destroy)");
  });

  it("lists import and move together with a real action", () => {
    const out = summarizePlan(
      base([
        rc("a_x.i", ["update"], {}, { importing: { id: "secret-import-id" }, before: { a: 1 }, after: { a: 2 } }),
        rc("a_x.m", ["delete", "create"], { previous_address: "a_x.old" }),
      ]),
      OPTS,
    );
    expect(out).toContain("IMPORT (1)\n  a_x.i (then update)");
    expect(out).toContain("MOVED (1)\n  a_x.old -> a_x.m (then delete-then-create)");
    expect(out).toContain("1 to import, 1 to add, 1 to change, 1 to destroy");
    expect(out).not.toContain("secret-import-id");
  });

  it("flags errored, not applyable, incomplete and unknown format versions; lists deferred changes", () => {
    const out = summarizePlan(
      base([], {
        format_version: "2.0",
        errored: true,
        applyable: false,
        complete: false,
        deferred_changes: [{ reason: "provider_config_unknown", resource_change: rc("a_x.d", ["create"]) }],
      }),
      OPTS,
    );
    expect(out.split("\n")[0]).toBe(
      "plan (terraform 1.15.7, format 2.0): ERRORED (planning failed; the changes below are partial), NOT applyable, " +
        "INCOMPLETE (another plan and apply is needed after this one), [unknown format_version 2.0: the summary may be incomplete]",
    );
    expect(out).toContain("DEFERRED (1)\n  a_x.d: create deferred (provider_config_unknown)");
  });

  it("says no changes and counts unchanged objects", () => {
    expect(summarizePlan(base([rc("a_x.same", ["no-op"])]), OPTS)).toBe(
      [
        "plan (terraform 1.15.7, format 1.2): applyable, complete",
        "totals: 0 delete, 0 replace, 0 update, 0 create, 0 read, 0 import, 0 move, 0 forget, 1 unchanged (terraform: 0 to add, 0 to change, 0 to destroy)",
        "no changes",
      ].join("\n"),
    );
  });

  it("warns about deletes paired with creates of the same type in the same module", () => {
    const out = summarizePlan(
      base([
        rc("aws_s3_bucket.old", ["delete"], { action_reason: "delete_because_no_resource_config" }),
        rc("aws_s3_bucket.new", ["create"]),
        rc("module.m.aws_s3_bucket.x", ["create"], { module_address: "module.m" }),
        rc("aws_iam_role.r", ["delete"], { action_reason: "delete_because_each_key" }),
      ]),
      OPTS,
    );
    expect(out).toContain(
      "WARNING: 2 object(s) will be destroyed (2 delete, 0 replace). No moved blocks in this plan.",
    );
    expect(out).toContain("Possible renames needing a moved block: aws_s3_bucket.old -> aws_s3_bucket.new");
    expect(out).toContain("  - aws_iam_role.r (for_each key no longer present)");
  });

  it("truncates long sections and counts action invocations", () => {
    const many = Array.from({ length: 5 }, (_, i) => rc(`a_x.c${i}`, ["create"]));
    const out = summarizePlan(base(many, { action_invocations: [{}, {}] }), { maxPerSection: 2, maxPaths: 8 });
    expect(out).toContain("CREATE (5)\n  + a_x.c0\n  + a_x.c1\n  ... 3 more");
    expect(out).toContain("(terraform: 5 to add, 0 to change, 0 to destroy; 2 actions to invoke)");
  });

  it("renders drift updates with their paths", () => {
    const out = summarizePlan(
      base([], {
        resource_drift: [
          rc("a_x.d", ["update"], {}, { before: { tags: { a: "1" } }, after: { tags: { a: "2" } } }),
          rc("a_x.e", ["create"]),
        ],
      }),
      OPTS,
    );
    expect(out).toContain(
      "DRIFT (detected during refresh) (2)\n  a_x.d: changed outside Terraform: tags.a\n  a_x.e: create outside Terraform",
    );
  });
});

describe("detectPlanJson", () => {
  it("accepts a plan representation", () => {
    expect(detectPlanJson(PLAN_TEXT).kind).toBe("plan");
    expect(detectPlanJson(`﻿${PLAN_TEXT}`).kind).toBe("plan");
  });

  it("refuses terraform plan -json UI-stream output", () => {
    expect(detectPlanJson(readFixture("plan/plan-ui-stream.jsonl"))).toEqual({
      kind: "refuse",
      message: UI_STREAM_MESSAGE,
    });
    const oneLine = readFixture("plan/plan-ui-stream.jsonl").split("\n")[0]!;
    expect(detectPlanJson(oneLine)).toEqual({ kind: "refuse", message: UI_STREAM_MESSAGE });
  });

  it("refuses rendered state, raw state and the no-state output", () => {
    expect(detectPlanJson(readFixture("state/state.json"))).toEqual({ kind: "refuse", message: STATE_MESSAGE });
    expect(detectPlanJson(JSON.stringify({ version: 4, lineage: "x", resources: [] }))).toEqual({
      kind: "refuse",
      message: STATE_MESSAGE,
    });
    const none = detectPlanJson(readFixture("state/no-state.json"));
    expect(none.kind).toBe("refuse");
    expect((none as { message: string }).message).toMatch(/no resource_changes or planned_values/);
  });

  it("refuses an HCP saved-plan bookmark without contacting anything", () => {
    const r = detectPlanJson(
      JSON.stringify({ remote_plan_format: 1, run_id: "run-abc123", hostname: "app.terraform.io" }),
    );
    expect(r).toEqual({
      kind: "refuse",
      message:
        "this is an HCP Terraform saved-plan bookmark for run run-abc123; get its plan id with the official terraform MCP server's get_run_details, fetch get_plan_json_output(plan_id), and pass that as plan_json (both need the official server's terraform toolset and TFE_TOKEN).",
    });
  });

  it("refuses non-JSON and non-object JSON", () => {
    expect((detectPlanJson("not json at all") as { message: string }).message).toMatch(
      /^not a Terraform plan: the input is not JSON/,
    );
    expect(detectPlanJson("[1,2]")).toEqual({
      kind: "refuse",
      message: "not a Terraform plan: expected a JSON object.",
    });
  });

  it("detects the zip signature of a binary plan", () => {
    expect(isZip(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]))).toBe(true);
    expect(isZip(Buffer.from("{}"))).toBe(false);
    expect(isZip(Buffer.from([0x50]))).toBe(false);
  });
});

describe("planShowErrorMessage", () => {
  it("maps real terraform show failures", () => {
    expect(planShowErrorMessage("Error: Failed to load plugin schemas\n\nunavailable provider", "/r", "/r/p")).toMatch(
      /providers it was made with are not installed in \/r/,
    );
    expect(planShowErrorMessage("Failed to read the given file as a state or plan file", "/r", "/r/p")).toBe(
      "/r/p is not a Terraform plan file (terraform could not read it as a plan or state).",
    );
    expect(planShowErrorMessage("something else", "/r", "/r/p")).toBeNull();
  });
});

it("fixture state used by tf_show_resource is not mistaken for a plan by the summary path", () => {
  // Guard against a renderer regression that would print values: summarizing must only ever see plan JSON.
  const state = readFixtureJson("state/state.json");
  expect(detectPlanJson(JSON.stringify(state)).kind).toBe("refuse");
});

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecOptions, RunResult } from "../schema.js";
import { TimeoutError } from "../schema.js";
import {
  backendType,
  listStateAddresses,
  noStateMessage,
  parseWorkspaceList,
  prepareState,
  renderAddresses,
  selectedWorkspace,
  showState,
  stateErrorMessage,
} from "../state.js";
import { cleanupTempDirs, fixtureRoot, readFixture } from "./helpers.js";

afterEach(cleanupTempDirs);

const stderr = (name: string) => readFixture(`state/stderr/${name}`);

describe("stateErrorMessage on real terraform stderr", () => {
  it.each([
    ["state-locked-windows.txt", /^The state file is locked by another Terraform process/],
    ["show-locked-windows.txt", /^The state file is locked by another Terraform process/],
    [
      "backend-init-required.txt",
      /^The s3 backend is configured but not initialized here .* Run terraform init in \/r; this server never does\./,
    ],
    ["s3-no-credentials.txt", /^Could not read state from the s3 backend: credentials are missing or expired/],
    ["http-401-requires-auth.txt", /^Could not read state from the s3 backend: credentials are missing or expired/],
    ["http-403-invalid-auth.txt", /^Could not read state from the s3 backend: credentials are missing or expired/],
    [
      "s3-missing-workspace-write-attempt.txt",
      /^terraform state list failed \(exit 1\) reading the s3 backend:\nError loading the state/,
    ],
  ])("%s", (file, re) => {
    const msg = stateErrorMessage("state list", 1, stderr(file), "/r", "s3");
    expect(msg).toMatch(re);
  });

  it("names the backend terraform requested when .terraform/terraform.tfstate does not exist (after init -backend=false)", () => {
    // backendType() falls back to "local" there; Terraform's own text says s3.
    const msg = stateErrorMessage("state list", 1, stderr("backend-init-required.txt"), "/r", "local");
    expect(msg).toMatch(/^The s3 backend is configured but not initialized here/);
    expect(stateErrorMessage("state list", 1, "Backend initialization required", "/r", "gcs")).toMatch(
      /^The gcs backend is configured/,
    );
  });

  it("appends terraform's own text, capped at 2 KiB", () => {
    const msg = stateErrorMessage(
      "state list",
      1,
      `No valid credential sources found\n${"x".repeat(5000)}`,
      "/r",
      "s3",
    );
    expect(msg).toContain("\nterraform said: No valid credential sources found");
    expect(msg.length).toBeLessThan(2600);
  });

  it("maps credential variants and partial init", () => {
    for (const s of [
      "StatusCode: 403",
      "AccessDenied: no",
      "ExpiredToken",
      "Required token could not be found",
      "could not find default credentials",
    ]) {
      expect(stateErrorMessage("show", 1, s, "/r", "gcs")).toMatch(/credentials are missing or expired/);
    }
    expect(stateErrorMessage("show", 1, "Error: Required plugins are not installed", "/r", "local")).toMatch(
      /^\/r is only partly initialized/,
    );
    expect(stateErrorMessage("show", 1, "Error: Module not installed", "/r", "local")).toMatch(
      /only partly initialized/,
    );
    // A request ID that merely contains 403 is not a credential error.
    expect(stateErrorMessage("show", 1, "RequestID: A4030B", "/r", "s3")).toMatch(/^terraform show failed/);
  });
});

describe("workspace selection and backend type", () => {
  it("prefers TF_WORKSPACE, then .terraform/environment, then default", () => {
    const root = fixtureRoot();
    expect(selectedWorkspace(root, {})).toEqual({ name: "default", source: "default" });
    writeFileSync(join(root, ".terraform", "environment"), "staging\n");
    expect(selectedWorkspace(root, {})).toEqual({ name: "staging", source: ".terraform/environment" });
    expect(selectedWorkspace(root, { TF_WORKSPACE: " ghost " })).toEqual({ name: "ghost", source: "TF_WORKSPACE" });
  });

  it("parses workspace list output", () => {
    expect(parseWorkspaceList("  default\n* staging\n  prod\n\n")).toEqual(["default", "staging", "prod"]);
  });

  it("reads only backend.type, defaulting to local", () => {
    const root = fixtureRoot();
    expect(backendType(root)).toBe("local");
    writeFileSync(
      join(root, ".terraform", "terraform.tfstate"),
      JSON.stringify({ backend: { type: "s3", config: { secret_key: "x" } } }),
    );
    expect(backendType(root)).toBe("s3");
    writeFileSync(join(root, ".terraform", "terraform.tfstate"), "not json");
    expect(backendType(root)).toBe("local");
  });
});

type Handler = (args: string[], opts: ExecOptions) => RunResult;
/** A mock TerraformExec around a synchronous handler. */
const mk = (h: Handler) => vi.fn(async (args: string[], opts: ExecOptions): Promise<RunResult> => h(args, opts));
const ok = (stdout: string): RunResult => ({ code: 0, stdout, stderr: "" });
const fail = (err: string, code = 1): RunResult => ({ code, stdout: "", stderr: err });

describe("prepareState / workspace guard", () => {
  it("never lists workspaces for default", async () => {
    const exec = mk(() => ok(""));
    const ctx = await prepareState(exec, fixtureRoot(), {});
    expect(ctx.workspace.name).toBe("default");
    expect(exec).not.toHaveBeenCalled();
  });

  it("refuses a missing non-default workspace before any state command", async () => {
    const exec = mk(() => ok("* default\n  prod\n"));
    await expect(prepareState(exec, fixtureRoot(), { TF_WORKSPACE: "ghost" })).rejects.toThrow(
      "workspace 'ghost' (from TF_WORKSPACE) does not exist in the backend. Reading it would make Terraform create it (it writes an empty state), so this server will not. Select an existing workspace: default, prod.",
    );
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec.mock.calls[0]![0]).toEqual(["workspace", "list", "-no-color"]);
  });

  it("strips TF_DATA_DIR from every state command, so the child reads the workspace the guard checked", async () => {
    const exec = mk((args) =>
      args[0] === "workspace" ? ok("  default\n* prod\n") : args[0] === "show" ? ok("{}") : ok(""),
    );
    const ctx = await prepareState(exec, fixtureRoot(), { TF_WORKSPACE: "prod" });
    await listStateAddresses(exec, ctx);
    await showState(exec, ctx);
    expect(exec).toHaveBeenCalledTimes(3);
    for (const call of exec.mock.calls) expect(call[1].env).toEqual({ TF_DATA_DIR: null });
  });

  it("accepts an existing non-default workspace", async () => {
    const exec = mk(() => ok("  default\n* prod\n"));
    const ctx = await prepareState(exec, fixtureRoot(), { TF_WORKSPACE: "prod" });
    expect(ctx.workspace).toEqual({ name: "prod", source: "TF_WORKSPACE" });
  });

  it("maps a failing workspace list", async () => {
    const exec = mk(() => fail(stderr("s3-no-credentials.txt")));
    await expect(prepareState(exec, fixtureRoot(), { TF_WORKSPACE: "prod" })).rejects.toThrow(
      /credentials are missing/,
    );
  });

  it("requires an initialized root", async () => {
    const exec = mk(() => ok(""));
    await expect(prepareState(exec, fixtureRoot({ initialized: false }), {})).rejects.toThrow(/is not initialized/);
  });
});

describe("state commands", () => {
  const ctx = (root = "/r") => ({ root, workspace: { name: "default", source: "default" as const }, backend: "local" });

  it("lists addresses, passes -id, and treats no state as a fact", async () => {
    const exec = mk((args) =>
      args.some((a) => a.startsWith("-id=")) ? ok("random_pet.a\n") : ok("random_pet.a\r\nrandom_pet.b\n"),
    );
    expect(await listStateAddresses(exec, ctx())).toEqual(["random_pet.a", "random_pet.b"]);
    expect(await listStateAddresses(exec, ctx(), "abc")).toEqual(["random_pet.a"]);
    expect(exec.mock.calls[1]![0]).toEqual(["state", "list", "-no-color", "-id=abc"]);
    const none = mk(() => fail(stderr("state-list-no-state.txt")));
    expect(await listStateAddresses(none, ctx())).toBeNull();
    const locked = mk(() => fail(stderr("state-locked-windows.txt")));
    await expect(listStateAddresses(locked, ctx())).rejects.toThrow(/locked by another Terraform process/);
  });

  it("show -json: no values means no state; bad JSON and failures are errors", async () => {
    expect(
      await showState(
        mk(() => ok(readFixture("state/no-state.json"))),
        ctx(),
      ),
    ).toBeNull();
    expect(
      await showState(
        mk(() => fail("No state file was found!")),
        ctx(),
      ),
    ).toBeNull();
    expect(
      (
        await showState(
          mk(() => ok(readFixture("state/state.json"))),
          ctx(),
        )
      )?.values,
    ).toBeTruthy();
    await expect(
      showState(
        mk(() => ok("nope")),
        ctx(),
      ),
    ).rejects.toThrow(/did not return valid JSON/);
    await expect(
      showState(
        mk(() => fail(stderr("show-locked-windows.txt"))),
        ctx(),
      ),
    ).rejects.toThrow(/locked/);
  });

  it("names the backend when a command times out", async () => {
    const exec = mk(() => {
      throw new TimeoutError("terraform state list did not finish", 5);
    });
    await expect(listStateAddresses(exec, { ...ctx(), backend: "s3" })).rejects.toThrow(
      "terraform state list did not finish within 5 ms (backend s3); the backend may be unreachable.",
    );
  });

  it("renders addresses with filter, id, limit and the empty cases", () => {
    const c = ctx();
    const all = ["random_integer.n[0]", "random_integer.n[1]", "module.naming.random_pet.this"];
    expect(renderAddresses(all, c, undefined, undefined, 200)).toBe(
      ["3 addresses in workspace 'default' (backend local)", ...all].join("\n"),
    );
    expect(renderAddresses(all, c, "random_integer", undefined, 1)).toBe(
      "2 addresses matching 'random_integer' in workspace 'default' (backend local)\nrandom_integer.n[0]\n... 1 more, narrow the filter",
    );
    expect(renderAddresses(all, c, "zzz", undefined, 10)).toBe("no addresses match 'zzz'");
    expect(renderAddresses([], c, undefined, "i-1", 10)).toBe("no resource instance has id 'i-1'");
    expect(renderAddresses([], c, undefined, undefined, 10)).toBe("0 addresses in workspace 'default' (backend local)");
    expect(renderAddresses(null, c, "x", undefined, 10)).toBe(noStateMessage("default", "local"));
    expect(noStateMessage("default", "local")).toBe(
      "No state in workspace 'default' (backend local): nothing has been applied yet.",
    );
  });
});

import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { getSchema, listProviders } from "../format.js";
import { createTerraformRunner, SchemaStore } from "../schema.js";
import { cleanupTempDirsInBackground, FIXTURE, FIXTURE_VERSIONS, fixtureRoot, tempDir } from "./helpers.js";

/**
 * Real terraform, end to end: a temp copy of the fixture root is initialized
 * (by the TEST, never by the server) and the server's own runner dumps it.
 *
 * Skipped when `terraform` is not on PATH. `terraform init` downloads
 * hashicorp/random and hashicorp/tls, so an offline host skips at runtime too.
 * Set TF_PLUGIN_CACHE_DIR to reuse providers between runs.
 */
const hasTerraform = !spawnSync("terraform", ["version"], { stdio: "ignore", windowsHide: true }).error;

describe.skipIf(!hasTerraform)("integration: real terraform", () => {
  // Background delete: the temp root holds real provider binaries, which a
  // loaded Windows host can take minutes to let go of (see the helper).
  afterAll(cleanupTempDirsInBackground);

  it("dumps the pinned schema and matches the committed fixture", { timeout: 300_000 }, async (ctx) => {
    const root = fixtureRoot({ initialized: false });
    const init = spawnSync("terraform", ["init", "-backend=false", "-input=false", "-no-color"], {
      cwd: root,
      encoding: "utf8",
      windowsHide: true,
      timeout: 240_000,
      env: { ...process.env, TF_IN_AUTOMATION: "1" },
    });
    if (init.status !== 0) {
      ctx.skip(`terraform init failed (offline?): ${(init.stderr || init.stdout || "").trim().slice(0, 300)}`);
    }

    const cacheDir = tempDir();
    const store = new SchemaStore({ cacheDir, runner: createTerraformRunner() });
    const { data, versions } = await store.load(root);

    expect(versions).toEqual(FIXTURE_VERSIONS);
    expect(listProviders(data, versions)).toBe(listProviders(FIXTURE, FIXTURE_VERSIONS));
    for (const [kind, name] of [
      ["resource", "random_password"],
      ["resource", "tls_self_signed_cert"],
      ["data", "tls_certificate"],
      ["ephemeral", "tls_private_key"],
    ] as const) {
      expect(getSchema(data, versions, name, kind, 3, 0)).toBe(getSchema(FIXTURE, FIXTURE_VERSIONS, name, kind, 3, 0));
    }
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });
});

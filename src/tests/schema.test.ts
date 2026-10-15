import { appendFileSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertInitialized,
  assertLocalPath,
  BAD_KIND_MESSAGE,
  cacheKey,
  createTerraformRunner,
  DEFAULT_TIMEOUT_MS,
  defaultCacheDir,
  defaultRootDir,
  defaultTimeoutMs,
  isKind,
  MAX_TIMEOUT_MS,
  NotInitializedError,
  parseLockVersions,
  SchemaStore,
  spawnError,
} from "../schema.js";
import { cleanupTempDirs, FIXTURE, FIXTURE_TEXT, FIXTURE_VERSIONS, FIXTURES, fixtureRoot, tempDir } from "./helpers.js";

afterEach(cleanupTempDirs);

function mockRunner(text = FIXTURE_TEXT) {
  return vi.fn(async (_root: string) => text);
}

describe("parseLockVersions", () => {
  it("reads every provider's pinned version from the fixture lock file", () => {
    const text = readFileSync(join(FIXTURES, "tfroot", ".terraform.lock.hcl"), "utf8");
    expect(parseLockVersions(text)).toEqual(FIXTURE_VERSIONS);
  });

  it("handles CRLF line endings and ignores constraints lines", () => {
    const text =
      'provider "registry.terraform.io/a/b" {\r\n  version     = "1.2.3"\r\n  constraints = "~> 1.0"\r\n}\r\n';
    expect(parseLockVersions(text)).toEqual({ "registry.terraform.io/a/b": "1.2.3" });
  });

  it("returns an empty map for an empty file", () => {
    expect(parseLockVersions("")).toEqual({});
  });
});

describe("cacheKey", () => {
  const lock = Buffer.from("lock");
  it("is 16 hex chars and deterministic", () => {
    expect(cacheKey("/a", lock)).toMatch(/^[0-9a-f]{16}$/);
    expect(cacheKey("/a", lock)).toBe(cacheKey("/a", lock));
  });
  it("changes with the root path and with the lock bytes", () => {
    expect(cacheKey("/a", lock)).not.toBe(cacheKey("/b", lock));
    expect(cacheKey("/a", lock)).not.toBe(cacheKey("/a", Buffer.from("lock2")));
  });
});

describe("kinds", () => {
  it("accepts resource | data | ephemeral only", () => {
    expect(["resource", "data", "ephemeral"].every(isKind)).toBe(true);
    expect(isKind("module")).toBe(false);
    expect(isKind("toString")).toBe(false);
  });
  it("words the bad-kind message like the prototype", () => {
    expect(BAD_KIND_MESSAGE).toBe("kind must be one of ['resource', 'data', 'ephemeral']");
  });
});

describe("defaults from env", () => {
  it("TERRAFORM_CWD_MCP_CACHE overrides ~/.cache/terraform-cwd-mcp", () => {
    expect(defaultCacheDir({})).toBe(join(homedir(), ".cache", "terraform-cwd-mcp"));
    expect(defaultCacheDir({ TERRAFORM_CWD_MCP_CACHE: "/x" })).toBe("/x");
  });
  it("TERRAFORM_CWD_MCP_DIR overrides process.cwd()", () => {
    expect(defaultRootDir({})).toBe(process.cwd());
    expect(defaultRootDir({ TERRAFORM_CWD_MCP_DIR: "/tf" })).toBe("/tf");
  });
  it("TERRAFORM_CWD_MCP_TIMEOUT_MS accepts positive numbers only", () => {
    expect(defaultTimeoutMs({})).toBe(DEFAULT_TIMEOUT_MS);
    expect(defaultTimeoutMs({ TERRAFORM_CWD_MCP_TIMEOUT_MS: "1500" })).toBe(1500);
    expect(defaultTimeoutMs({ TERRAFORM_CWD_MCP_TIMEOUT_MS: "0" })).toBe(DEFAULT_TIMEOUT_MS);
    expect(defaultTimeoutMs({ TERRAFORM_CWD_MCP_TIMEOUT_MS: "soon" })).toBe(DEFAULT_TIMEOUT_MS);
    // Above 2^31-1 setTimeout would fire after 1 ms; clamp instead.
    expect(defaultTimeoutMs({ TERRAFORM_CWD_MCP_TIMEOUT_MS: "3000000000" })).toBe(MAX_TIMEOUT_MS);
  });
});

describe("assertInitialized", () => {
  it("passes an initialized root", () => {
    expect(() => assertInitialized(fixtureRoot())).not.toThrow();
  });

  it("names .terraform/ and says to run init when it is missing", () => {
    const root = fixtureRoot({ initialized: false });
    expect(() => assertInitialized(root)).toThrow(NotInitializedError);
    expect(() => assertInitialized(root)).toThrow(
      /missing \.terraform\/\)\. Run `terraform init -backend=false` there first/,
    );
  });

  it("names both when the lock file is missing too", () => {
    expect(() => assertInitialized(fixtureRoot({ initialized: false, lock: false }))).toThrow(
      /missing \.terraform\.lock\.hcl and \.terraform\//,
    );
  });

  it("rejects a path that is not a directory", () => {
    expect(() => assertInitialized(join(tempDir(), "nope"))).toThrow(/does not exist or is not a directory/);
  });
});

describe("assertLocalPath", () => {
  it.each([
    "\\\\host\\share\\x",
    "//host/share/x",
    "\\\\?\\C:\\x",
    "\\\\.\\pipe\\x",
    "/\\host\\x",
  ])("rejects UNC / device path %s", (p) => {
    expect(() => assertLocalPath(p)).toThrow(/UNC or device path/);
  });

  it("accepts local paths", () => {
    for (const p of ["C:\\tf\\root", "/home/u/tf", "relative/dir", "."]) expect(() => assertLocalPath(p)).not.toThrow();
  });

  it("is enforced by SchemaStore before any fs or terraform call", async () => {
    const runner = mockRunner();
    const store = new SchemaStore({ cacheDir: tempDir(), runner });
    await expect(store.load("\\\\attacker\\share\\root")).rejects.toThrow(/UNC or device path/);
    await expect(store.load("//attacker/share/root")).rejects.toThrow(/UNC or device path/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe("SchemaStore", () => {
  it("loads via the runner and returns the resolved root, dump and versions", async () => {
    const root = fixtureRoot();
    const runner = mockRunner();
    const store = new SchemaStore({ cacheDir: tempDir(), runner });
    const loaded = await store.load(root);
    expect(loaded.root).toBe(resolve(root));
    expect(loaded.data).toEqual(FIXTURE);
    expect(loaded.versions).toEqual(FIXTURE_VERSIONS);
    expect(runner).toHaveBeenCalledWith(resolve(root));
  });

  it("never runs terraform for an uninitialized root", async () => {
    const runner = mockRunner();
    const store = new SchemaStore({ cacheDir: tempDir(), runner });
    await expect(store.load(fixtureRoot({ initialized: false }))).rejects.toThrow(/terraform init/);
    expect(runner).not.toHaveBeenCalled();
  });

  it("uses defaultDir when dir is omitted", async () => {
    const root = fixtureRoot();
    const store = new SchemaStore({ cacheDir: tempDir(), defaultDir: root, runner: mockRunner() });
    expect((await store.load()).root).toBe(resolve(root));
    expect((await store.load("")).root).toBe(resolve(root));
  });

  it("serves a repeat load from memory", async () => {
    const root = fixtureRoot();
    const runner = mockRunner();
    const cacheDir = tempDir();
    const store = new SchemaStore({ cacheDir, runner });
    await store.load(root);
    // Remove the disk entry so only the in-memory layer can answer.
    for (const f of readdirSync(cacheDir)) rmSync(join(cacheDir, f));
    await store.load(root);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("writes <key>.json to the cache dir and a fresh store hits it without terraform", async () => {
    const root = fixtureRoot();
    const cacheDir = tempDir();
    await new SchemaStore({ cacheDir, runner: mockRunner() }).load(root);
    const key = cacheKey(resolve(root), readFileSync(join(root, ".terraform.lock.hcl")));
    expect(readdirSync(cacheDir)).toEqual([`${key}.json`]);
    expect(readFileSync(join(cacheDir, `${key}.json`), "utf8")).toBe(FIXTURE_TEXT);

    const runner = mockRunner();
    const loaded = await new SchemaStore({ cacheDir, runner }).load(root);
    expect(runner).not.toHaveBeenCalled();
    expect(loaded.data).toEqual(FIXTURE);
  });

  it("re-runs terraform after the lock file changes (provider upgrade)", async () => {
    const root = fixtureRoot();
    const runner = mockRunner();
    const store = new SchemaStore({ cacheDir: tempDir(), runner });
    await store.load(root);
    appendFileSync(join(root, ".terraform.lock.hcl"), "\n# upgraded\n");
    await store.load(root);
    expect(runner).toHaveBeenCalledTimes(2);
    // The superseded dump is dropped, not kept resident next to the new one.
    expect((store as unknown as { mem: Map<string, unknown> }).mem.size).toBe(1);
  });

  it("regenerates a corrupt cache entry", async () => {
    const root = fixtureRoot();
    const cacheDir = tempDir();
    const key = cacheKey(resolve(root), readFileSync(join(root, ".terraform.lock.hcl")));
    writeFileSync(join(cacheDir, `${key}.json`), '{"provider_schemas": {tr');
    const runner = mockRunner();
    const loaded = await new SchemaStore({ cacheDir, runner }).load(root);
    expect(runner).toHaveBeenCalledTimes(1);
    expect(loaded.data).toEqual(FIXTURE);
    expect(JSON.parse(readFileSync(join(cacheDir, `${key}.json`), "utf8"))).toEqual(FIXTURE);
  });

  it("shares one terraform run between concurrent loads", async () => {
    const root = fixtureRoot();
    const runner = mockRunner();
    const store = new SchemaStore({ cacheDir: tempDir(), runner });
    await Promise.all([store.load(root), store.load(root), store.load(root)]);
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("surfaces a runner failure and caches nothing", async () => {
    const root = fixtureRoot();
    const cacheDir = tempDir();
    const store = new SchemaStore({
      cacheDir,
      runner: vi.fn(async () => {
        throw new Error("terraform providers schema failed (exit 1):\nboom");
      }),
    });
    await expect(store.load(root)).rejects.toThrow(/boom/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("rejects non-JSON output without caching it", async () => {
    const root = fixtureRoot();
    const cacheDir = tempDir();
    const store = new SchemaStore({ cacheDir, runner: mockRunner("not json") });
    await expect(store.load(root)).rejects.toThrow(/did not return valid JSON/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("still answers when the cache dir cannot be written", async () => {
    const root = fixtureRoot();
    const blocker = join(tempDir(), "file");
    writeFileSync(blocker, "x");
    // cacheDir is a path UNDER a regular file, so mkdir fails.
    const store = new SchemaStore({ cacheDir: join(blocker, "cache"), runner: mockRunner() });
    expect((await store.load(root)).data).toEqual(FIXTURE);
    expect(existsSync(join(blocker, "cache"))).toBe(false);
  });
});

describe("createTerraformRunner", () => {
  it("explains a binary that is not on PATH", async () => {
    const run = createTerraformRunner({ binary: "terraform-cwd-mcp-no-such-binary" });
    await expect(run(tempDir())).rejects.toThrow(/not found on PATH.*TERRAFORM_CWD_MCP_BINARY/s);
  });

  it("rejects a .cmd/.bat binary on Windows with the fix", async () => {
    if (process.platform !== "win32") return;
    const run = createTerraformRunner({ binary: "C:\\tools\\terraform.cmd" });
    await expect(run(tempDir())).rejects.toThrow(/\.cmd\/\.bat shims.*terraform\.exe/s);
  });

  it("maps spawn errors to actionable messages", () => {
    const enoent = Object.assign(new Error("spawn x ENOENT"), { code: "ENOENT" });
    const einval = Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" });
    expect(spawnError("terraform", enoent, "win32").message).toMatch(/not found on PATH \(\.cmd\/\.bat shims/);
    expect(spawnError("terraform", enoent, "linux").message).not.toMatch(/shims/);
    expect(spawnError("x.cmd", einval, "win32").message).toMatch(/terraform\.exe/);
    expect(spawnError("x", einval, "linux").message).toBe("could not run 'x': spawn EINVAL");
  });

  it("reports a non-zero exit with its stderr", async () => {
    // node treats `providers` as a script path and exits 1 with "Cannot find module".
    const run = createTerraformRunner({ binary: process.execPath });
    await expect(run(tempDir())).rejects.toThrow(/failed \(exit 1\):[\s\S]*Cannot find module/);
  });
});

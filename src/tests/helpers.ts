import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SchemaDump } from "../schema.js";

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

/** Raw `terraform providers schema -json` output for hashicorp/random 3.9.1 + hashicorp/tls 4.4.1. */
export const FIXTURE_TEXT = readFileSync(join(FIXTURES, "schema.json"), "utf8");
export const FIXTURE: SchemaDump = JSON.parse(FIXTURE_TEXT);
export const FIXTURE_VERSIONS = {
  "registry.terraform.io/hashicorp/random": "3.9.1",
  "registry.terraform.io/hashicorp/tls": "4.4.1",
};

const tempDirs: string[] = [];

export function tempDir(prefix = "tfcwd-test-"): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

export function cleanupTempDirs(): void {
  for (const d of tempDirs.splice(0)) {
    try {
      // Retries: on Windows a provider .exe that terraform just ran (or that
      // Defender is still scanning) stays locked for a moment -> EPERM.
      rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // A leftover temp dir is not a test failure.
    }
  }
}

/**
 * Background variant for dirs holding real provider binaries: on a loaded
 * Windows host, deleting a freshly-run provider .exe can take longer than any
 * sane hook timeout (Defender scans it first), so start the delete and move on.
 */
export function cleanupTempDirsInBackground(): void {
  for (const d of tempDirs.splice(0)) {
    rm(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
  }
}

/**
 * A temp copy of the fixture root module. `initialized` adds an empty
 * .terraform/ so it passes the init check without real providers (the schema
 * itself comes from a mocked runner or a pre-seeded cache).
 */
export function fixtureRoot(opts: { initialized?: boolean; lock?: boolean } = {}): string {
  const { initialized = true, lock = true } = opts;
  const root = tempDir("tfcwd-root-");
  copyFileSync(join(FIXTURES, "tfroot", "main.tf"), join(root, "main.tf"));
  if (lock) copyFileSync(join(FIXTURES, "tfroot", ".terraform.lock.hcl"), join(root, ".terraform.lock.hcl"));
  if (initialized) mkdirSync(join(root, ".terraform"));
  return root;
}

/**
 * A temp copy of a committed fixture root (`modroot`, `upgrade/uproot`) with
 * `dot-terraform/` renamed to `.terraform/` (the repo ignores `.terraform/`).
 */
export function fixtureCopy(rel: string): string {
  const root = tempDir("tfcwd-fx-");
  cpSync(join(FIXTURES, rel), root, { recursive: true });
  if (existsSync(join(root, "dot-terraform"))) renameSync(join(root, "dot-terraform"), join(root, ".terraform"));
  return root;
}

export const readFixture = (rel: string): string => readFileSync(join(FIXTURES, rel), "utf8");
export const readFixtureJson = <T = any>(rel: string): T => JSON.parse(readFixture(rel)) as T;

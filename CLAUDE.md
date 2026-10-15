# terraform-cwd-mcp

MCP server answering "what is actually true in THIS Terraform working directory". 9 read-only tools:

- Schema tools (ported from a tested Python prototype, output text matches it line for line, with four extensions under Key patterns): `tf_list_providers`, `tf_search_types`, `tf_get_schema`, `tf_check_arguments`. Source of truth is `terraform providers schema -json`; versions come from `.terraform.lock.hcl`.
- Capability tools (design and evidence: `docs/design-capabilities.md`): `tf_summarize_plan`, `tf_module_interface`, `tf_state_addresses`, `tf_show_resource`, `tf_upgrade_impact`.

Complements HashiCorp's terraform-mcp-server, never replaces it. Authority split (also in `INSTRUCTIONS` and the tool descriptions): this server wins on argument validity for the pinned version and on this directory's plan/state/modules; the official server wins on usage docs, latest versions, public registry modules and HCP/TFE runs.

## Architecture

- `src/index.ts` -- CLI entry point. `--version` / `-V`, else starts the stdio server.
- `src/server.ts` -- Creates McpServer (with `instructions`), registers tools. Exports `createTerraformCwdServer(opts)` and `startServer()` (which also sweeps stale upgrade temp dirs in the background), and re-exports every module below as the library surface.
- `src/schema.ts` -- Root resolution, the init check, lock-file parsing, the cache key, the shared terraform runner (`createTerraformExec` -> `{ code, stdout, stderr }`; `createTerraformRunner` = the schema dump on top of it), and `SchemaStore` (memory + disk cache, in-flight de-dup; also carries `exec` and `pluginCacheDir` for the other tools).
- `src/format.ts` -- Pure renderers behind the four schema tools.
- `src/tools.ts` -- Zod shapes and handlers for all nine tools. Thrown errors become `isError` results via `guard()`.
- `src/plan.ts` -- tf_summarize_plan: input detection (binary zip, plan JSON, UI stream, state, HCP bookmark) and the pure renderer.
- `src/state.ts` -- tf_state_addresses / tf_show_resource: workspace guard, backend type, stderr -> message mapping, state commands, flattening + redaction of one resource.
- `src/redact.ts` -- The four redaction layers (markers, document-wide value matching, key-name heuristic, value shape). Pure.
- `src/hcl.ts` -- tree-sitter-hcl reader (vendored WASM read from `../vendor` relative to dist/; lazy singleton parser): literal evaluator, heredocs from the raw span, CST type rendering, attribute-read extraction, `.tf.json`, Terraform's file selection rules. `src/config.ts` builds the module model (variables, outputs, module calls, required_providers, resources, refs) with override-file merging.
- `src/module.ts` -- tf_module_interface: module resolution (address via `.terraform/modules/modules.json`, or path) and rendering.
- `src/upgrade.ts` -- tf_upgrade_impact: usage collection, schema comparison rules, constraint report, target-schema download into a temp dir + plugin cache, validate on a linked temp copy, diagnostics diff, rendering.
- `src/constraints.ts` -- Terraform provider version-constraint evaluator. Pure.
- `vendor/tree-sitter-hcl/` -- grammar WASM + Apache-2.0 LICENSE + SOURCE.md (upstream commit, sha256). Shipped via package.json `files`.
- `bin/terraform-cwd-mcp.mjs` -- npm `bin`, the oam-discovering runtime launcher (see Runtime below). Prefers the newest oam at or above `OAM_MIN` (0.19.0), else imports `dist/index.js` into its own process.
- `scripts/runtime.mjs` (oam discovery for the dev scripts), `scripts/typecheck.mjs` (`oam check .`, else tsc), `scripts/check-oam-floor.mjs` (floor drift + staleness).

## Key patterns

- **NEVER run `terraform init` in the user's directory.** Not as a fallback, not behind a flag. A missing `.terraform/` or lock file is a `NotInitializedError` telling the user to run `terraform init -backend=false`. The server must stay read-only: init downloads providers, may contact a backend and can rewrite the lock file. The ONE init the server runs is tf_upgrade_impact's, in a fresh `mkdtemp` dir holding only a generated `main.tf` (target provider into the plugin cache); never in a copy of the user's config, and never in the validate dir (Terraform's installer replacing a package dir behind a junction is the hazard).
- **State reads never lock, never refresh, never create.** Only `terraform state list` and `terraform show -json` (neither calls Lock; RefreshState re-reads storage). A non-default workspace (TF_WORKSPACE, else `.terraform/environment`) is checked against `terraform workspace list` first: reading a missing one makes the s3 backend PutObject an empty state. No caching of state. Only `backend.type` is read from `.terraform/terraform.tfstate` (`config` can hold secrets).
- **Plan summaries print no values; state output (and tf_module_interface variable defaults) is redacted in four layers** (redact.ts). Numbers and bools get the key-name layer and an exact match against marked numbers (>= 4 digits); layer 4 also masks inline `password=...` / `AccountKey=...` credentials and catches base64-encoded PEM private keys. Import IDs are never printed (for random_* the import ID is the secret). Output values are never printed by any tool. Fixture tests assert no `FIXTURE-SECRET` / `FIXTURE-plain` sentinel ever appears in output.
- **tf_upgrade_impact touches only temp dirs and caches.** Validate runs twice (pinned lock, then target lock + `zz_tfcwd_upgrade_override.tf` under the root's own local name) on a copy whose `.terraform/providers/<addr>/<v>/<platform>` entries are junctions (Windows) / symlinks to `realpath` of installed packages; state, tfvars, `.terraform/` (except `modules/`), `.git`, plans are never copied; 100 MB / 20,000-file cap. `rmSync` does not follow links (asserted by the integration test). Calls are serialized in-process. Validate problems (including a validate timeout or spawn failure) never fail the tool: they degrade to "schema comparison only: <reason>". A cached target schema is reused only when the plugin cache still holds its package (when validate needs it); otherwise the target is downloaded again, falling back to the cached schema if that fails. Provider configuration blocks (`provider "x" { ... }`, aliases included; `alias`/`version` are meta) are compared against the `provider` schema too.
- **Every terraform child gets `CHECKPOINT_DISABLE=1`** (plus `TF_IN_AUTOMATION=1`, `TF_INPUT=0`), otherwise each command phones home and `openWorldHint: false` would be a lie. `openWorldHint: true` on the state tools (remote backends) and tf_upgrade_impact (registry download).
- **Every string parameter has `maxLength`** (paths 4096, addresses/ids 1024, filters 512, provider 256, version 64); `plan_json` is the documented 50 MB exception.
- **Terraform is spawned with an args array, `shell: false`, `cwd` = the resolved root.** stdout is collected as a Buffer stream, not through `execFile`'s `maxBuffer` -- the AWS provider dumps tens of MB. stderr is capped at 64 KiB for the error message. `TF_IN_AUTOMATION=1` and `TF_INPUT=0` are set. On Windows, CreateProcess resolves bare `terraform` to `terraform.exe`, so no shell is needed.
- **Cache key = first 16 hex of sha256(resolved root path + lock file bytes).** Memory map first, then `<cacheDir>/<key>.json`. A corrupt disk entry is a miss and is rewritten; a failed write (atomic tmp + rename) is ignored. Concurrent loads of one key share one terraform run. `.terraform/` contents are NOT in the key -- the lock file changes on every provider upgrade, which is the invalidation that matters.
- **`kind` is `z.string()`, not `z.enum`**, so a bad kind gets the prototype's one-line answer (`kind must be one of ['resource', 'data', 'ephemeral']`) as normal text, not a schema-validation error.
- **Attribute lookups use `Object.hasOwn`**, so a path segment like `constructor` is UNKNOWN rather than matching `Object.prototype`.
- Extensions over the prototype: (1) `tf_get_schema` expands nested attributes (`nested_type`, plugin protocol 6) under the same `max_depth` budget instead of stopping at `nested:<mode>`; (2) `tf_check_arguments` walks into nested attributes (`settings.mode`) instead of answering "is an attribute, not a block"; (3) `tf_check_arguments` marks a deprecated block `ok (block) [deprecated]`; (4) descriptions collapse every whitespace run (incl. CRLF) to one space, where the prototype only replaced `\n`.

- **`dir` must be a local path.** `assertLocalPath` rejects UNC and device paths (`\\host\share`, `//host/share`, `\\?\`, `\\.\`) before any fs call: on Windows a stat of a UNC path opens SMB and can leak the user's NTLM hash. `dir` is otherwise unconfined (it is the tool's whole point), so note that `terraform providers schema` executes the provider plugins under `<dir>/.terraform/providers`.
- **Windows `.cmd`/`.bat` binaries are refused** with a message naming `terraform.exe`: they cannot run without a shell, and Node throws EINVAL for them anyway.
- **The memory cache holds one dump per resolved root** (`{ key, data }`); a lock-file change replaces it rather than leaving the superseded dump resident.
- **npm only: no SEA binary (Jeff, 2026-10-15).** The package ships through npm and nothing else; there is no standalone-executable build, no release assets and no oam-compiled carrier. The parser loads the grammar from `vendor/` relative to dist/ and web-tree-sitter finds its own runtime WASM, on Node and under the launcher's `oam run dist/index.js` alike.
- **Tool names carry the `tf_` prefix** (`tf_list_providers`, `tf_search_types`, `tf_get_schema`, `tf_check_arguments`). Jeff decided this on 2026-10-14, before the first publish, together with the rename from terraform-schema-mcp to terraform-cwd-mcp: bare names like `get_schema` collide with other servers behind an aggregator such as Yaw MCP, and `tf_` is short. New tools get the same prefix. Renaming after 0.1.0 is a breaking change.

## Runtime: oam or Node

[oam](https://oamjs.org) is not an npm dependency and is never assumed present. Ported from caddy-mcp; the no-sandbox shape follows ssh-mcp.

| Task | Default | Alternate |
|---|---|---|
| `bin` entry (`bin/terraform-cwd-mcp.mjs`) | newest oam at or above 0.19.0, else Node in-process | `TERRAFORM_CWD_MCP_RUNTIME=node` / `=oam`, `OAM_BIN`; see the launcher header |
| `npm run typecheck` | `oam check .` if available, else `tsc --noEmit` | `TERRAFORM_CWD_MCP_RUNTIME=node` forces tsc; `typecheck:tsc` pins it |
| `npm test`, `npm start` | Node | -- |

- **Launcher discovery:** `OAM_BIN` (used when usable, else named on stderr and skipped), then `OAM_INSTALL_DIR`, `%LOCALAPPDATA%\oam\bin` (Windows), `~/.oam/bin`, then `PATH` (`.exe` only on Windows; a `.cmd`/`.bat` shim is named, never run). Every candidate is asked `--version` and counts only if the output carries oam's own banner (`oam x.y.z` at the start of a line, `oamBanner`): a bare x.y.z is not enough, or an `OAM_BIN` pointing at node (`v22.x.y`) would clear the floor and be spawned as `node run dist/index.js` with no fallback. `process.versions.oam` keeps the loose parse (only oam sets it). The newest at or above the floor wins, a tie keeps search order. `scripts/runtime.mjs` has its own, deliberately different discovery (full PATHEXT, first that runs) for the typecheck script; unlike caddy's it has no `findOam({ require })` option (its only caddy caller built an oam-compiled binary).
- **Already on oam:** launched as `oam run bin/terraform-cwd-mcp.mjs` (Yaw MCP does this) on an oam at the floor, it serves in-process, no second oam. A host oam below the floor never serves: it hands off, with piped stdio, to a newer oam or to Node on PATH, or exits 1. Pure decision in `runtimePlan({ mode, hostOam })`.
- **No `--permission` sandbox:** every tool path spawns terraform (which runs provider plugins), reads caller-named dirs and writes caches/temp dirs, so nothing narrow can be granted. `stripPermissionFlags` drops oam's `--permission`/`--allow-*` from NODE_OPTIONS before any child is spawned from an oam host.
- **Why the floor matters here:** the terraform spawns pass an explicit `env` that DELETES `TF_DATA_DIR` (and `TF_WORKSPACE` for tf_upgrade_impact); oam up to 0.17.x laid an explicit env over its own, resurrecting deleted variables. Verified on 0.19.0 (deleted var stays deleted; handshake, tf_module_interface, tf_list_providers, tf_upgrade_impact all match Node).
- **Floor policy:** one verified oam release at a time, the latest. `scripts/check-oam-floor.mjs` (`npm run check:oam-floor`) fails on any floor claim in the launcher, README.md, CLAUDE.md or `src/tests/launcher.test.ts` that disagrees with `OAM_MIN` (offline half, run on every `npm test` via `oam-floor.test.ts`), and on a floor behind the latest GitHub release of YawLabs/oam (online half, run by release.sh; `TERRAFORM_CWD_MCP_ALLOW_STALE_OAM=1` overrides). Bumping: change `OAM_MIN`, re-verify (MCP handshake plus tf_module_interface and tf_upgrade_impact under the new oam), then fix every claim the checker names.

## Environment variables

All optional. The server's own are read in `src/schema.ts`; the runtime ones in the launcher and scripts.

| Var | Default | Purpose |
|---|---|---|
| `TERRAFORM_CWD_MCP_DIR` | `process.cwd()` | Root module when a call passes no `dir`. |
| `TERRAFORM_CWD_MCP_CACHE` | `~/.cache/terraform-cwd-mcp` | Disk cache directory. |
| `TERRAFORM_CWD_MCP_BINARY` | `terraform` | Binary to spawn (`tofu` works). |
| `TERRAFORM_CWD_MCP_TIMEOUT_MS` | `300000` | Kill timeout for every terraform command. Values below 1 fall back to the default; values above 2^31-1 are clamped. |
| `TERRAFORM_CWD_MCP_PLUGIN_CACHE` | `TF_PLUGIN_CACHE_DIR`, else `<cache>/plugins` | Plugin cache for tf_upgrade_impact downloads. |
| `TERRAFORM_CWD_MCP_RUNTIME` | `auto` | Read by `bin/terraform-cwd-mcp.mjs` and `scripts/runtime.mjs`, not src/: `auto`, `oam` or `node` (case-insensitive in both). |
| `OAM_BIN` / `OAM_INSTALL_DIR` | (unset) | oam discovery inputs for the launcher (and `OAM_BIN` for runtime.mjs; both probes are bounded at 5s). |
| `TERRAFORM_CWD_MCP_ALLOW_STALE_OAM` | (unset) | `1` lets `check-oam-floor.mjs` pass with a floor behind the latest oam release. |

`TF_DATA_DIR` is not honoured (tools look for `<root>/.terraform`); it is removed from the env of the state commands (so the child reads the workspace the guard checked, not `$TF_DATA_DIR/environment`) and of the temp-dir init and validate runs.

## Tests

- `src/tests/fixtures/schema.json` is real `terraform providers schema -json` output for hashicorp/random 3.9.1 + hashicorp/tls 4.4.1, with the matching `tfroot/.terraform.lock.hcl`. Tests copy the root to a temp dir and add an empty `.terraform/`.
- `format.test.ts` -- renderers, incl. a hand-built dump for deprecated types/blocks, nested attributes and deep nesting.
- `schema.test.ts` -- lock parsing, cache key, init check, cache hit/miss/corruption/invalidation, runner errors.
- `server.test.ts` -- real McpServer + Client over InMemoryTransport: the nine-tool listing, annotations, maxLength, descriptions and instructions, and the four schema tools end to end (the five capability tools run end to end in `server-capabilities.test.ts`).
- `integration.test.ts` -- runs real `terraform init` + the server's runner on a temp copy, and asserts the output equals the fixture's. Skipped when `terraform` is not on PATH, or at runtime when init fails (offline). On Windows, deleting its temp root (fresh provider .exe files) can take over 60 s, so cleanup runs in the background and may leave a `tfcwd-root-*` dir in %TEMP%.
- Capability fixtures (`plan/`, `state/`, `modroot/`, `upgrade/`) are real Terraform 1.15.7 output with secrets replaced by sentinels; see `src/tests/fixtures/README.md`. `fixtureCopy(rel)` copies one to a temp dir and renames `dot-terraform` to `.terraform`.
- `plan.test.ts`, `redact.test.ts`, `state.test.ts`, `hcl.test.ts` (incl. the oracle test: our reader vs the plan JSON `configuration` section, 49 variables/outputs, 0 mismatches), `constraints.test.ts`, `upgrade.test.ts` (design findings on the real dumps, hand-built dumps for the other rules, and the whole tool against a fake terraform with real files and junctions).
- `server-capabilities.test.ts` -- the five capability tools over InMemoryTransport with an injected `exec`.
- `launcher.test.ts` -- ported from caddy-mcp (minus the sandbox cases) plus ssh-mcp's stripPermissionFlags/Windows-shim/hygiene cases. Extracts `runtimePlan`, `pickNewest` and `stripPermissionFlags` from the launcher source (importing it would launch a server) and pins `expect(floor).toEqual([0, 19, 0])`; runs the real bin under Node posing as oam (a `--import` preload sets `process.versions.oam` and makes the launcher's `--version` probe of the test's own node, which is `OAM_BIN`, answer `oam 0.19.0`); the unpatched node as `OAM_BIN` is the non-oam regression case (passed over in auto, refused under `=oam`); an isolated env (empty HOME/LOCALAPPDATA, PATH = node's dir) for "no oam anywhere", including a stdio MCP smoke through bin/. The signal, discovery, version-gate and vanishing-oam cases use bash fakes and skip on Windows. A last block drives a REAL oam (OAM_BIN or the installed locations, at the floor) and skips without one; its `oam run dist/index.js` smoke runs under `TERRAFORM_CWD_MCP_RUNTIME=oam`, because auto would fall back to Node silently and pass anyway.
- `oam-floor.test.ts` -- check-oam-floor.mjs as a subprocess: the real repo has no drift, and synthetic trees with drift fail.
- `integration-capabilities.test.ts` -- real terraform: apply + plan -out in a temp root, binary plan == show -json summary and matches terraform's `Plan:` line, no live secret in any output; state tools; workspace guard creates nothing; a pending apply holds the lock (Windows: lock message); tf_upgrade_impact on the fixture root (root untouched, temp dirs gone, linked packages intact, offline rerun); constraint evaluator vs `terraform init`. Uses a temp `TF_PLUGIN_CACHE_DIR`.

## Commands

```bash
npm run build      # tsup + tsc declarations
npm run dev        # Watch mode
npm test           # vitest
npm run lint       # Biome check (via scripts/lint.mjs)
npm run lint:fix   # Biome auto-fix
npm run typecheck  # oam check . if oam is installed, else tsc --noEmit (typecheck:tsc pins tsc)
npm run test:ci    # Build + test
npm run check:compliance  # @yawlabs/mcp-compliance, must grade A (after build; release.sh runs it)
npm run check:oam-floor   # oam floor drift + staleness (release.sh runs it)
```

Release: `bash release.sh X.Y.Z` (no CI workflows in this repo).

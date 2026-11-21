# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] -- 2026-11-21

### Security
- Terraform children no longer inherit the server's environment. Every command
  that can start a provider plugin gets an allowlisted environment without
  `AWS_*`, `TF_VAR_*`, `TF_TOKEN_*` or other credentials. `tf_show_resource`
  renders pulled state without them, and the schema dump runs from a temp dir that
  never touches the backend.
- Remote backend reads get credentials only with
  `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1`, and then only that backend's own
  variables: backend configuration can run a command (`credential_process`) that
  sees whatever terraform was given.
- A `terraform` binary planted in the working directory is no longer run on Windows
  when the MCP host has not set `NoDefaultCurrentDirectoryInExePath`, and relative
  `PATH` entries are removed from the environment of terraform children.
- `dir`, module paths and manifest entries, in `tf_module_interface` and
  `tf_upgrade_impact`, are confined (links resolved) to the server's directory and
  `TERRAFORM_CWD_MCP_ALLOWED_DIRS`; `plan_file` to `dir`.
- `tf_upgrade_impact` requires `TERRAFORM_CWD_MCP_ALLOW_UPGRADE=1`.
- `tf_summarize_plan` refuses plan JSON without a 1.x `format_version` and a valid
  `resource_changes` list (unless the rest of the document shows a plan with no
  resource instances) instead of reporting "no changes", and marks JSON input as
  unverified. A delete with `mode: "data"` on a managed address is now a
  delete. Addresses and other document strings are escaped, sensitive instance
  keys are hidden (also when they hold escaped characters), and parse errors no
  longer quote the input. Every instance address `planned_values` or
  `prior_state` names must be accounted for by a change, drift or deferred entry
  (moves by `previous_address`), so removing, emptying or decoy-replacing the
  change list cannot hide a resource; when the JSON is the caller's, a data-source
  deletion says its mode and address were the caller's claim, and a delete inside
  `deferred_changes` raises its own warning (it is in no count otherwise).
- `tf_state_addresses` escapes the `filter` and `id` echoed in its messages, and
  `tf_show_resource` escapes a forged `schema_version`, so neither can forge
  output lines.
- `moduleFiles` skips a `.tf` symlink that resolves outside its module directory,
  so read-only `tf_module_interface` cannot follow a planted link out of the
  boundary, and state messages escape a workspace name forged through
  `.terraform/environment` instead of printing it as its own line.
- State tools hide map keys and instance keys that equal a sensitive value or look
  like a secret, and `tf_state_addresses` refuses state whose resource names would
  forge output lines.
- Redaction also covers AWS access key IDs and `aws_sk` / `*_CRED` names. It is
  described as best effort.

### Changed
- The `terraform-cwd-mcp` command now requires oam 0.21.1 or newer (was
  0.20.2); an older oam is passed over for Node, as before. Verified on oam
  0.21.1 through the launcher: MCP handshake, `tools/list`,
  `tf_module_interface`, `tf_list_providers` and `tf_upgrade_impact` match
  Node, and a child spawned with `TF_DATA_DIR` deleted does not see it.
- **Breaking:** a `dir` outside the server's directory is refused; set
  `TERRAFORM_CWD_MCP_DIR` or `TERRAFORM_CWD_MCP_ALLOWED_DIRS`. A relative `dir` now
  resolves against the server's directory.
- **Breaking:** a `plan_file` outside `dir` is refused; copy it into `dir`.
- **Breaking:** `tf_upgrade_impact` is off by default.
- **Breaking:** plan JSON without `format_version` is refused, and so is plan JSON
  without `resource_changes` unless it has `configuration` and `planned_values` and
  names no resource in them, `prior_state` or `resource_drift`.
- **Breaking:** state tools on a remote backend no longer receive its credential or
  proxy variables by default; set `TERRAFORM_CWD_MCP_ALLOW_BACKEND_CREDENTIALS=1` if
  the backend needs them. Credentials Terraform finds without them keep working.
- **Breaking:** `tf_upgrade_impact` fails when a `modules.json` entry is outside the
  allowed directories; add it to `TERRAFORM_CWD_MCP_ALLOWED_DIRS`.
- **Breaking:** `tf_state_addresses` prints hidden instance keys as `(redacted key)`,
  and its `filter` matches the printed text. It also runs `terraform state pull`, and
  `terraform show` (which starts plugins) when an address has a string key.
  `tf_show_resource` accepts the printed form.
- **Breaking:** a wrapper or plugin that relied on an inherited variable needs it
  named in `TERRAFORM_CWD_MCP_PASS_ENV`.
- Tools that start terraform no longer claim `readOnlyHint`, and declare
  `openWorldHint`; only `tf_module_interface` is read-only. Clients may now ask for
  approval before calling them.
- Removed data sources are listed under `DATA SOURCE REMOVED` instead of omitted.
- Schema tools work on a root initialized with `-backend=false` that has a backend
  block, as the README always said.
- The release pre-flight checks the Yaw MCP floor: `scripts/check-yaw-mcp-floor.mjs`
  (`npm run check:yaw-mcp-floor`) fails on drift between `YAW_MCP_MIN` 1.1.13, the
  README's "Yaw MCP 1.1.13 or newer" and the `@yawlabs/mcp-compliance` devDependency
  (`^0.20.4`, the range Yaw MCP 1.1.13 pins), and warns without failing when a newer
  @yawlabs/mcp is published. Release tooling and docs only.

## [0.1.4] -- 2026-11-16

### Security
- `@hono/node-server` override raised to `^2.1.3` (was `^1.19.15`, inside the
  range of GHSA-rmxm-3fg6-px4f); it resolves to 2.1.8 and `npm audit` reports
  0. The `hono`, `fast-uri`, `ip-address` and `qs` override floors are raised
  to `^4.13.16`, `^3.1.9`, `^10.7.6` and `^6.17.1`.

## [0.1.3] -- 2026-11-15

### Changed
- The `terraform-cwd-mcp` command now requires oam 0.20.2 or newer (was
  0.19.1); an older oam is passed over for Node, as before. Verified on oam
  0.20.2 through the launcher: MCP handshake, `tools/list`,
  `tf_module_interface`, `tf_list_providers` and `tf_upgrade_impact` match
  Node, and a child spawned with `TF_DATA_DIR` deleted does not see it.
- `@modelcontextprotocol/sdk` range is `^1.32.2` (was `^1.32.1`), the range
  Yaw MCP 1.1.13 ships with.

### Security
- Lockfile-only `npm audit fix`: `body-parser` 2.4.0, `hono` 4.13.18,
  `@hono/node-server` 1.19.19, `fast-uri` 3.1.9, `undici` 8.12.4 and
  `vitest` / `@vitest/mocker` 4.1.12 (dev).

## [0.1.2] -- 2026-10-31

### Changed
- The `terraform-cwd-mcp` command now requires oam 0.19.1 or newer (was
  0.19.0); an older oam is passed over for Node, as before. Verified on oam
  0.19.1 through the launcher: MCP handshake, `tf_module_interface`,
  `tf_list_providers` and `tf_upgrade_impact` match Node, and a child spawned
  with `TF_DATA_DIR` deleted does not see it.

### Fixed
- `TERRAFORM_CWD_MCP_RUNTIME` is trimmed as well as lowercased, in the launcher
  and in `npm run typecheck`: cmd.exe's `set TERRAFORM_CWD_MCP_RUNTIME=node && ...`
  stores `node `, which silently ran `auto` instead of forcing Node.
- `npm run check:oam-floor` run from a junctioned or symlinked checkout no
  longer exits 0 without checking anything: the main-module test now
  realpaths both sides.

## [0.1.1] -- 2026-10-16

### Security
- `tf_upgrade_impact` no longer writes the lock or override file through a
  symlink copied from the root: a `.terraform.lock.hcl` symlinked to a shared
  lock could be overwritten with the target provider version.
- `tf_upgrade_impact` applies its exclusions (`.terraform`, `.git`, state,
  `*.tfvars`, plans) before copying links, so a symlinked excluded entry is no
  longer linked into the temp copy. Saved plans are excluded by name (`tfplan`,
  `plan.out`, `*.plan`) and by content (a zip whose first entry is `tfplan`).
- `tf_upgrade_impact` skips `modules.json` dirs that are UNC or device paths
  before touching them (no SMB lookup).
- State output redacts the `value` of a name/value pair whose name is
  secret-like (helm `set`, kubernetes `env`, ECS `container_definitions` JSON).
- Inline credential masking covers `PGPASSWORD=`-style run-together names,
  `DB_PASS=`, `Authorization: Bearer|Basic ...` and Azure SAS `sig=`; value
  shapes add Vault (`hvs.`/`hvb.`/`hvr.`), HCP Terraform (`.atlasv1.`) and
  Stripe (`sk_live_`/`rk_live_`/`sk_test_`) tokens.
- `tf_module_interface` masks credentials in module sources (URL userinfo,
  `sshkey`, `token`, `sig` and other secret query parameters).

### Fixed
- `tf_upgrade_impact`: a file-system error while copying the configuration
  degrades to "schema comparison only" instead of failing the tool.
- Override files: a `dynamic "x"` block replaces the base's `x` blocks (static
  and dynamic) and no longer removes other `dynamic` blocks, matching Terraform.
- `npm run typecheck` accepts an oam binary only when it prints oam's version
  banner (`OAM_BIN` pointing at node falls back to tsc).
- `release.sh` checks for a clean tree, `HEAD == origin/main` and `jq`.

## [0.1.0] -- 2026-10-15

### Added
- Initial release: `tf_list_providers`, `tf_search_types`, `tf_get_schema` and
  `tf_check_arguments`, answering from `terraform providers schema -json` for the
  provider versions pinned in `.terraform.lock.hcl`. Kinds `resource`, `data`
  and `ephemeral`; every tool takes an optional `dir`.
- Schema dumps cached in memory and on disk, keyed on the root path plus the
  lock file bytes (`TERRAFORM_CWD_MCP_CACHE`, default
  `~/.cache/terraform-cwd-mcp`).
- Never runs `terraform init`; an uninitialized root module gets an actionable
  error instead.
- `tf_summarize_plan`: summary of a saved plan (binary or JSON file) or plan
  JSON text (e.g. an HCP run's plan from the official server), destroys first,
  with Terraform's own `Plan:` counts and a rename / moved-block warning. Prints
  no values.
- `tf_module_interface`: variables (exact types, defaults, flags, validation
  counts), outputs and module calls of the root, a local module or an installed
  module address, read with a vendored tree-sitter-hcl grammar.
- `tf_state_addresses` and `tf_show_resource`: read-only state access that
  never locks or refreshes, refuses to select a missing workspace (which would
  create it), and redacts sensitive values in four layers.
- `tf_upgrade_impact`: what a provider upgrade/downgrade breaks for the
  arguments this configuration uses, with constraint checks and a `terraform
  validate` comparison on a linked temp copy (`TERRAFORM_CWD_MCP_PLUGIN_CACHE`).
- The `terraform-cwd-mcp` command runs the server on [oam](https://oamjs.org)
  when it finds oam 0.19.0 or newer (`OAM_BIN`, `OAM_INSTALL_DIR`,
  `%LOCALAPPDATA%\oam\bin` (Windows), `~/.oam/bin`, then `PATH`; the newest
  wins) and on Node otherwise, in the launcher's own process at no extra cost.
  `TERRAFORM_CWD_MCP_RUNTIME=oam` requires oam, `=node` forces Node. Launched as
  `oam run` on a supported oam it serves in-process instead of starting a second
  oam; an older oam host hands off to a newer oam or to Node. Ported from
  caddy-mcp's launcher without its `--permission` sandbox. Verified on oam
  0.19.0: MCP handshake, `tf_module_interface`, `tf_list_providers` and
  `tf_upgrade_impact` through the launcher. A candidate counts as oam only if
  its `--version` output carries oam's own `oam x.y.z` banner, so an `OAM_BIN`
  that is really another program (node prints `v22.x.y`) is passed over instead
  of being spawned with no fallback.
- `npm run check:oam-floor` (also run by `release.sh`): every oam floor claim in
  the repo agrees with the launcher's `OAM_MIN` (offline, on every `npm test`),
  and the floor is not behind the latest oam release
  (`TERRAFORM_CWD_MCP_ALLOW_STALE_OAM=1` to release on it deliberately).
- `npm run typecheck` uses `oam check .` when oam is installed, else
  `tsc --noEmit` (`TERRAFORM_CWD_MCP_RUNTIME=node` forces tsc, read
  case-insensitively like the launcher; the oam probe is bounded at 5s so a
  wedged binary cannot hang the check).

### Changed
- Distributed through npm only. The standalone-executable build, its config,
  its release assets and the embedded-asset parser path are gone; the HCL
  parser always loads the vendored grammar from `vendor/`.
- Every terraform child process now gets `CHECKPOINT_DISABLE=1`, so no command
  phones home for a version check.
- Descriptions collapse every whitespace run (including CRLF) to one space.

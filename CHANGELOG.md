# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

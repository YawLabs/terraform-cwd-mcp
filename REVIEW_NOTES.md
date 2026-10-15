# Review notes (second pre-commit review, 2026-10-15)

Findings from the reviewers' pass over this server and the four Yaw Mode `yaw-tf*` skills, each checked against the
code (and, where it mattered, real Terraform 1.15.7 output) before acting. Every code fix has a regression test.
The previous notes file (first review) was stale and is replaced by this one; its durable content is in CLAUDE.md.

## Fixed -- server code

- **module.ts normalizeModuleSource (high): false STALE.** Now normalizes like `addrs.ParseModuleSource`: local
  paths are Go `path.Clean`ed with a leading `./` kept (`../../` -> `../..`, `./m/` -> `./m`, `./x/../m` -> `./m`,
  backslashes -> `/`), `github.com/` / `bitbucket.org/` shorthands -> `git::https://host/o/r.git[//sub][?q]`,
  scp-style `user@host:path` -> `git::ssh://user@host/path`. Tests use a real `modules.json` from `terraform init`
  (local, github, github + subdir) plus the reviewer's real scp value; the cloudposse `examples/complete` module
  now shows 0 STALE of 53 calls (was 27).
- **module.ts renderDefault (medium): secrets in variable defaults.** Values under a secret-like key at any depth
  are replaced, and URL passwords / inline `password=...` credentials are masked in literal and expression
  defaults. Fixture test asserts no `FIXTURE-` sentinel survives.
- **plan.ts changedPaths (low): set index shift.** When a list changes length, the list is reported once with a
  multiset count (`input.s (1 removed)`) instead of every shifted index; equal-length lists stay per index. Only
  counts are printed, never elements.
- **state.ts (high): TF_DATA_DIR bypass of the workspace guard.** Every state command now runs with
  `TF_DATA_DIR` removed, so the child reads the workspace the guard checked. Unit test on the exec env, plus a
  real-terraform integration step (TF_DATA_DIR with `environment=ghost`: 4 addresses from default, no
  `terraform.tfstate.d/ghost`); without the fix that step fails.
- **redact.ts (medium): sensitive numbers.** Marked numbers of >= 4 digits join the document-wide set; number
  leaves are matched exactly. Bools are deliberately not value-matched (every `true` would match).
- **state.ts (medium): number/bool leaves skipped the key-name layer.** `Redactor.redactScalar` applies the name
  heuristic and the numeric match.
- **redact.ts (medium): run-together env-var names.** A token containing `password` / `passwd` / `secret`, or
  ending in `pwd` / `token` / `apikey` / `privatekey`, is secret (`PGPASSWORD`, `ADMINPASSWORD`, `MYSQLPWD`);
  `secretsmanager` is excluded and the metadata last-token rule still applies (`PGPASSWORD_FILE`).
- **redact.ts (medium): inline credentials.** New `maskInlineCredentials` (in `maskInlineSecrets` with the URL
  mask) masks `Password=x;`, `--password=x`, `"token": "x"`, `AccountKey=x`, `aws_secret_access_key=x`,
  `?token=x&`, counted as shape.
- **redact.ts (low): base64-encoded PEM keys.** Shape for `LS0tLS1CRUdJTi...` followed by any of the three base64
  alignments of `PRIVATE KEY` (computed, not copied: the third is `UklWQVRFIEtFW`); base64 certificates and
  public keys are not matched.
- **state.ts (low): wrong backend name after `init -backend=false`.** The name now comes from Terraform's
  `requested backend "x"` text when present.
- **state.ts (low): http backend auth.** `/endpoint (requires|invalid) auth/i` maps to the credentials message.
  Real stderr captured against a local fake http backend (401 and 403) is in
  `src/tests/fixtures/state/stderr/http-40{1,3}-*.txt`; the endpoint saw only `GET /state`.
- **upgrade.ts (high): provider configuration block never compared.** `provider "x" { ... }` blocks (aliases,
  renamed local names, `.tf.json`; `alias` / `version` are meta) are compared against the `provider` schema with
  the same rules, and include_unused lists provider-block changes as `provider <type>.<path>`. Test uses the real
  kubernetes 1.13.4 / 2.0.0 provider-block schemas (`load_config_file` REMOVED). Not done: a provider with no
  `provider` block is not checked for newly required provider arguments (they are usually settable from env).
- **upgrade.ts (medium): validate timeout failed the tool.** Timeouts and spawn errors of either validate run
  degrade to `validate: skipped (terraform validate timed out after N ms (raise TERRAFORM_CWD_MCP_TIMEOUT_MS))`.
- **upgrade.ts (medium): pruned plugin cache left validate skipped forever.** With validate requested, a cached
  target schema is used only if its plugin-cache package exists; otherwise the target is downloaded again, and the
  cached schema is still used if that download fails (the skip message now says to rerun with registry access).
- **upgrade.ts (low): ` (read)` key suffix.** Dropped; reads share the argument key.
- **upgrade.ts (low): include_unused filtered by finding keys.** `usageFindings` now returns `usedKeys` (every set
  path, every read, every used type, every finding key); `unusedChanges` takes that.
- **upgrade.ts (low): misleading "resolved" counts.** With new errors, the line says
  `N baseline diagnostics not re-checked (validate stopped at the new errors)` instead.
- **upgrade.ts (low): bare provider type.** `local` resolves when exactly one locked provider has that type; an
  ambiguous or malformed input gets `provider must be <namespace>/<type>, e.g. hashicorp/local`.
- **upgrade.ts (low): download timeout message.** Init / schema timeouts in the temp dir say so, say nothing in
  the root changed, and name `TERRAFORM_CWD_MCP_TIMEOUT_MS`.
- **tools.ts (medium): tf_list_providers description** now says it lists only this directory's locked providers,
  does not search the registry, and names the official server's `search_provider_docs` /
  `get_latest_provider_version`. server.test asserts the four overlapping tools name the official server.
- **plan.ts / tools.ts / README (high, server side of the skill finding): HCP plan fetch.** The bookmark refusal,
  the tf_summarize_plan description and the README now say `get_run_details` -> plan id ->
  `get_plan_json_output(plan_id)`, and that it needs the official server's `terraform` toolset and `TFE_TOKEN`.
- **tools.ts (low): untested plan_file branches.** Tests for a directory as plan_file and a sparse non-zip file
  over the 200 MB cap.

## Fixed -- docs

- README: install-button description matches server.json; tf_check_arguments verdict list includes `ok (block)`
  and `is an attribute, not a block`; "Pairs well with" names the `--toolsets=registry,terraform` + `TFE_TOKEN`
  need and the `search_providers` -> `search_provider_docs` rename (v1.3.1).
- CLAUDE.md: "four extensions"; the server.test.ts line describes what it covers; TF_DATA_DIR, redaction and
  upgrade notes updated for the fixes above.
- REVIEW_NOTES.md: replaced (this file).

## Fixed -- Yaw Mode skills (`yaw_terminal/yaw/content/yaw-mode/skills/yaw-tf*`)

Facts checked against hashicorp/terraform-mcp-server source on GitHub (get_provider_details needs
`provider_doc_id`; search_provider_docs takes `provider_version`; get_plan_json_output takes `plan_id`;
`DefaultToolsets()` is `[registry]`; get_module_details takes a versioned `module_id`; 1.3.1 renamed
search_providers).

- All four: docs lookups are the two-step `search_provider_docs` (`search_providers` before v1.3.1) ->
  `get_provider_details(provider_doc_id)`, passing `provider_version` = the pinned version (the upgrade guide uses
  `provider_document_type: "guides"` and the target version).
- yaw-tf: fix every line that is not plain `ok` / `ok (block)` (adds READ-ONLY and "is an attribute, not a
  block"); public modules go `search_modules` -> `get_module_details`.
- yaw-tf-plan-review: HCP path `get_run_details` -> `get_plan_json_output(plan_id)`, toolset/token need, fallback
  covers an official server without them; exact labels `ERRORED`, `NOT applyable`, `INCOMPLETE`, `OUTPUTS`;
  scanners on the fetched HCP JSON via a temp file outside the repo; caveat that the HCP JSON puts clear-text
  sensitive values in the session.
- yaw-tf-refactor: state tools need a full `terraform init` (they refuse after `-backend=false`); the proof is the
  totals line `0 delete, 0 replace` (empty sections are not printed).
- yaw-tf-upgrade: split the address into `namespace` / `name` for get_latest_provider_version; BLOCKED + registry
  module path via `get_latest_module_version` / `search_modules` / versioned `get_module_details`; compound
  `BLOCKED ...; also BREAKING` and "schema comparison only" verdicts covered; `tf_check_arguments` moved after the
  re-lock (before it, it checks the old schema).
- Triggers qualified with "terraform" / "provider" so they no longer collide with yaw-implement / yaw-review or
  npm upgrades; descriptions cut to <= 299 chars and yaw-tf's routing sentence dropped (the body has it).
- Checks: `npm run audit:yaw-mode` PASS; bundle-shape, build-bundle, audit, typed-cli-version-guard, fingerprint,
  mcp-verbs, mcp-routing-skills, rules-sync and yaw-mode tests: 686 passed, 1 skipped.

## Skipped

- **tools.ts:58 strict zod objects (info).** Optional per the finding. check:compliance already grades A; the
  warning is about a 1 MB value under an unknown key, which zod strips before any handler sees it. Rejecting
  unknown keys would turn harmless extras (some clients and aggregators add fields) into validation errors, and
  needs a move from `server.tool` to `registerTool` for all nine tools. Left as is.
- **Bitbucket via API (part of the module-source finding).** go-getter's Bitbucket detector asks the Bitbucket API
  whether a repo is git or Mercurial; the normalizer assumes git (Mercurial support ended in 2020).

## Checks

Run in `terraform-cwd-mcp` after the fixes: `npm run lint:fix` (clean), `npx tsc --noEmit` (clean), `npm test`
(297/297 in 12 files, none skipped, incl. the real-terraform integration tests), `npm run build` (OK), `npm run check:compliance`
(grade A, score 100, 45/45; the oversized-input grader warning remains, see Skipped). package.json keeps `"private": true`.

## oam launcher pass + SEA removal (2026-10-15)

Jeff's decision: npm only. CLAUDE.md records it in one line ("npm only: no SEA binary (Jeff, 2026-10-15)"); that is
the only mention left (checked with `grep -riE` over the repo, excluding node_modules and vendor).

### Removed

- The standalone-executable build script, its JSON config, the stale build output (`build-tmp/`,
  `bin/win32-arm64/`) and its test file.
- `src/hcl.ts`: the lazy `node:sea` import, the asset-key constants, the `SeaApi`/`ParserWasm` types and
  `parserWasm()`. `getParser()` again calls `Parser.init()` and loads the grammar from `../vendor` relative to dist/.
- `src/server.ts`: the `__VERSION__` define fallback (only that build set it); the version comes from package.json.
- devDependencies `esbuild` and `postject` (only that build used them; esbuild stays as tsup/vite's transitive dep,
  with the existing `overrides` pin). `.gitignore`: `bin/*`, `build-tmp/`, `dist-release/`.
- `scripts/runtime.mjs`: `findOam({ require })` and both branches. Its only caddy-mcp caller built an oam-compiled
  binary; the port header now says so.
- Docs: the CLAUDE.md pattern, runtime-table row, test entry and the "Not yet ported" section (release-asset
  scripts); the CHANGELOG entries; three design-doc lines.

### Fixed

- **Launcher accepted any x.y.z as oam (bin:241).** The `--version` probe of OAM_BIN or a discovered binary now
  needs oam's own banner (`oamBanner`, `/^oam\s+(\d+\.\d+\.\d+)/m`); `process.versions.oam` keeps the loose
  parse. Regression tests in launcher.test.ts ("a non-oam OAM_BIN": the real node as OAM_BIN is passed over in
  auto and refused under `=oam`; both fail against the old probe). The Node-posing-as-oam tests now patch the
  launcher's `execFileSync` probe for that one node in their preload, since they relied on the loose parse.
  Verified by hand: `OAM_BIN=<node.exe> node bin/terraform-cwd-mcp.mjs --version` names it and uses the real oam.
- **Launcher comment named console.log (bin:~700).** Now `process.stdout.write`, which is what src/index.ts does.
- **Dead `require` option in runtime.mjs.** Deleted (see Removed).
- **Real-oam smoke could pass on Node.** It runs under `TERRAFORM_CWD_MCP_RUNTIME=oam`, so a failed oam choice or
  spawn exits non-zero instead of falling back. `findRealOam` also needs the banner now.
- **release.sh banner (line 289)** lists the oam floor check.
- **CHANGELOG discovery order** now matches the code and CLAUDE.md: `OAM_BIN`, `OAM_INSTALL_DIR`,
  `%LOCALAPPDATA%\oam\bin` (Windows), `~/.oam/bin`, `PATH`.

### Skipped / deferred

- **Banner fix in caddy-mcp and ssh-mcp (parity).** Not changed here: out of this repo's scope, and caddy-mcp has
  an uncommitted `vitest.config.ts` in its tree. Both have the same loose probe (caddy bin:260, ssh bin:248), and
  caddy's Node-posing tests use `OAM_BIN: process.execPath`, so they need the same preload patch as this repo's
  launcher.test.ts `runOnHost`. Follow-up.

### Checks

`npm run lint:fix` (no fixes), `npx tsc --noEmit` and `npm run typecheck` (clean), `npm run build` (OK), `npm test`
(346 passed, 13 skipped in 14 files; the skips are the bash-fake launcher cases on Windows), `npm run check:compliance`
(grade A, score 100, 45/45). Stdio initialize + tools/list (9) + tf_module_interface on a temp copy of the modroot
fixture through bin/ on Node (`=node`), on the oam path (`=oam`, oam 0.19.0) and in-process under `oam run bin/...`:
all `5 variables, 2 outputs`, no isError. `npm pack --dry-run`: 22 files, vendor/tree-sitter-hcl (WASM, LICENSE,
SOURCE.md) included, nothing from the removed build. package.json keeps `"private": true`.

## Launcher/runtime follow-up review (2026-10-15)

A re-review of the launcher pass above found three small holes; each has a
regression test that was watched to fail without the fix.

### Fixed

- **Launcher: the top-level in-process branch was unguarded (bin:659).** Every
  other in-process fallback routes through `fallbackFailed`, but `plan ===
  "in-process"` called `await runInProcess()` bare -- a broken install (missing
  `dist/index.js`) printed a raw Node `ERR_MODULE_NOT_FOUND` stack instead of
  the launcher's one-line diagnostic. Now `.catch(fallbackFailed)`. Test:
  `launcher.test.ts` "a broken install on the in-process path" (reproduces on a
  copy of the launcher with no `dist/` beside it, under `=node`).
- **`scripts/runtime.mjs`: `TERRAFORM_CWD_MCP_RUNTIME` read case-sensitively.**
  The launcher lowercases the value, so `=NODE` forces Node there; the typecheck
  script compared exactly and silently used oam the launcher would have refused.
  Now lowercased to match. Test: `runtime.test.ts` (the fix's discriminating
  case points `OAM_BIN` at the real Node, so `null` proves the early return
  fired, not that nothing was found).
- **`scripts/runtime.mjs`: the `oam --version` probe had no timeout.** A wedged
  oam on PATH blocked `npm run typecheck` forever; the launcher bounds every
  probe at 5s. Added `VERSION_PROBE_TIMEOUT_MS`. Test: `runtime.test.ts`
  (extracts `findOam` source and asserts the `execFileSync` call carries the
  bound -- a shell-sleep fixture would be POSIX-only).

### Added

- `src/tests/runtime.test.ts` (5 tests). It spawns `scripts/runtime.mjs` as a
  subprocess rather than importing it: the file is a `.mjs` outside `src/`, so a
  direct import from a `.ts` test fails `tsc` (no declaration, outside
  `rootDir`) -- the same reason `launcher.test.ts` extracts/spawns.

### Checks

`npm run lint:fix` (fixed the one formatting diff in the new test), `npm run
typecheck` (clean, oam 0.19.0), `npm run build` (OK), `npm test` (352 passed, 13
skipped in 15 files), `npm run check:oam-floor` (no drift, current),
`npm run check:compliance` (grade A). All local, Windows.
